// TaskGraph — the in-memory task graph every store reads from.
//
// All writes are TaskOps applied by `applyTaskOp`. The same ops go to AD4M
// (ad4m-store.ts) and to the outbox (durable.ts), so the in-memory copy, the
// local snapshot and the perspective all move through one vocabulary.
//
// Every op is idempotent and last-writer-wins per field or per link, so a
// replayed op sequence — after a crash mid-replay, or over a snapshot that
// already holds some of the ops — ends in the same state.

import type { ListTaskFilter, Task, TaskFields, TaskListItem, TaskProvider, TaskRecord, TaskRef } from './types.js'
import { normalizeProvider, providerKey, providerRepos } from './types.js'

export type TaskOp =
  /** Create or overwrite a task's scalar fields (links stay). */
  | { type: 'task.put'; task: TaskRecord }
  /** Change some fields of an existing task. */
  | { type: 'task.update'; id: string; fields: TaskFields }
  | { type: 'link.add'; parentId: string; childId: string }
  | { type: 'link.remove'; parentId: string; childId: string }

export interface TaskGraph {
  tasks: Map<string, TaskRecord>
  /** child id → parent ids */
  parents: Map<string, Set<string>>
  /** parent id → child ids */
  children: Map<string, Set<string>>
}

/** JSON form of a TaskGraph (snapshot file, AD4M load). */
export interface TaskGraphData {
  tasks: TaskRecord[]
  links: Array<[parentId: string, childId: string]>
}

export function emptyTaskGraph(): TaskGraph {
  return { tasks: new Map(), parents: new Map(), children: new Map() }
}

function cloneRecord(t: TaskRecord): TaskRecord {
  const out: TaskRecord = { ...t, tags: [...t.tags] }
  if (t.provider) out.provider = structuredClone(t.provider)
  else delete out.provider
  return out
}

/** Fill defaults and migrate legacy provider shapes on a record read from disk or AD4M. */
export function normalizeRecord(raw: Partial<TaskRecord> & { id: string; name: string }): TaskRecord {
  const rec: TaskRecord = {
    id: raw.id,
    name: raw.name,
    state: raw.state ?? 'pending',
    threadId: raw.threadId ?? null,
    description: raw.description ?? null,
    transientState: raw.transientState ?? null,
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? null,
    tags: Array.isArray(raw.tags) ? [...raw.tags] : [],
    membrane: raw.membrane ?? null,
    isStream: raw.isStream === true
  }
  const provider = normalizeProvider(raw.provider)
  if (provider) rec.provider = provider
  return rec
}

/** Migrate any legacy shapes inside an op read back from the outbox. */
export function normalizeTaskOp(raw: unknown): TaskOp | undefined {
  const op = raw as TaskOp
  if (!op || typeof op !== 'object') return undefined
  switch (op.type) {
    case 'task.put':
      if (!op.task?.id || typeof op.task.name !== 'string') return undefined
      return { type: 'task.put', task: normalizeRecord(op.task) }
    case 'task.update': {
      if (typeof op.id !== 'string' || !op.fields) return undefined
      const fields: TaskFields = { ...op.fields }
      if (fields.provider !== undefined) {
        const p = normalizeProvider(fields.provider)
        if (p) fields.provider = p
        else delete fields.provider
      }
      return { type: 'task.update', id: op.id, fields }
    }
    case 'link.add':
    case 'link.remove':
      if (typeof op.parentId !== 'string' || typeof op.childId !== 'string') return undefined
      return { type: op.type, parentId: op.parentId, childId: op.childId }
    default:
      return undefined
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(value)
}

function removeFrom(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key)
  if (!set) return
  set.delete(value)
  if (set.size === 0) map.delete(key)
}

export function applyTaskOp(g: TaskGraph, op: TaskOp): void {
  switch (op.type) {
    case 'task.put':
      g.tasks.set(op.task.id, cloneRecord(op.task))
      return
    case 'task.update': {
      const t = g.tasks.get(op.id)
      if (!t) return
      const f = op.fields
      if (f.name !== undefined) t.name = f.name
      if (f.state !== undefined) t.state = f.state
      if (f.threadId !== undefined) t.threadId = f.threadId
      if (f.description !== undefined) t.description = f.description
      if (f.transientState !== undefined) t.transientState = f.transientState
      if (f.updatedAt !== undefined) t.updatedAt = f.updatedAt
      if (f.tags !== undefined) t.tags = [...f.tags]
      if (f.membrane !== undefined) t.membrane = f.membrane
      if (f.isStream !== undefined) t.isStream = f.isStream
      if (f.provider !== undefined) t.provider = structuredClone(f.provider)
      return
    }
    case 'link.add':
      addTo(g.children, op.parentId, op.childId)
      addTo(g.parents, op.childId, op.parentId)
      return
    case 'link.remove':
      removeFrom(g.children, op.parentId, op.childId)
      removeFrom(g.parents, op.childId, op.parentId)
      return
  }
}

export function taskGraphToData(g: TaskGraph): TaskGraphData {
  const links: Array<[string, string]> = []
  for (const [parent, kids] of g.children) for (const child of kids) links.push([parent, child])
  return { tasks: [...g.tasks.values()].map(cloneRecord), links }
}

export function taskGraphFromData(data: Partial<TaskGraphData> | null | undefined): TaskGraph {
  const g = emptyTaskGraph()
  for (const raw of data?.tasks ?? []) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
    g.tasks.set(raw.id, normalizeRecord(raw))
  }
  for (const pair of data?.links ?? []) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue
    applyTaskOp(g, { type: 'link.add', parentId: pair[0], childId: pair[1] })
  }
  return g
}

/** Ops that recreate the whole graph (used to seed an empty or new perspective). */
export function taskGraphToOps(g: TaskGraph): TaskOp[] {
  const data = taskGraphToData(g)
  return [
    ...data.tasks.map((task): TaskOp => ({ type: 'task.put', task })),
    ...data.links.map(([parentId, childId]): TaskOp => ({ type: 'link.add', parentId, childId }))
  ]
}

// ── Queries ───────────────────────────────────────────────────────────

function ref(g: TaskGraph, id: string): TaskRef | null {
  const t = g.tasks.get(id)
  return t ? { id: t.id, name: t.name, state: t.state } : null
}

function refs(g: TaskGraph, ids: Set<string> | undefined): TaskRef[] {
  const out: TaskRef[] = []
  for (const id of ids ?? []) {
    const r = ref(g, id)
    if (r) out.push(r)
  }
  return out
}

/** Count of linked ids that exist as tasks. */
function liveCount(g: TaskGraph, ids: Set<string> | undefined): number {
  let n = 0
  for (const id of ids ?? []) if (g.tasks.has(id)) n++
  return n
}

export function readTask(g: TaskGraph, id: string): Task | null {
  const t = g.tasks.get(id)
  if (!t) return null
  return {
    ...cloneRecord(t),
    parentTasks: refs(g, g.parents.get(id)),
    childTasks: refs(g, g.children.get(id))
  }
}

/** Every task below `rootId` (through nested streams), excluding the root. */
export function descendants(g: TaskGraph, rootId: string): Set<string> {
  const seen = new Set<string>()
  const stack = [rootId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const child of g.children.get(cur) ?? []) {
      if (child === rootId || seen.has(child)) continue
      seen.add(child)
      stack.push(child)
    }
  }
  return seen
}

export function ancestors(g: TaskGraph, id: string): Set<string> {
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const parent of g.parents.get(cur) ?? []) {
      if (seen.has(parent)) continue
      seen.add(parent)
      stack.push(parent)
    }
  }
  return seen
}

export function findByProviderKey(g: TaskGraph, key: string): TaskRecord | null {
  for (const t of g.tasks.values()) {
    if (t.provider && providerKey(t.provider) === key) return t
  }
  return null
}

function matchesRepo(p: TaskProvider | undefined, repo: string): boolean {
  if (!p) return false
  const want = repo.toLowerCase()
  return providerRepos(p).some((r) => r.toLowerCase() === want)
}

export function listTasks(g: TaskGraph, filter: ListTaskFilter = {}): TaskListItem[] {
  const inStream = filter.workstream ? descendants(g, filter.workstream) : null
  const out: TaskListItem[] = []
  for (const t of g.tasks.values()) {
    if (filter.state && t.state !== filter.state) continue
    if (filter.threadId !== undefined && t.threadId !== filter.threadId) continue
    if (filter.parentId && !g.parents.get(t.id)?.has(filter.parentId)) continue
    if (filter.rootsOnly && liveCount(g, g.parents.get(t.id)) > 0) continue
    if (filter.membrane !== undefined && t.membrane !== filter.membrane) continue
    if (filter.repo && !matchesRepo(t.provider, filter.repo)) continue
    if (inStream && !inStream.has(t.id)) continue
    if (filter.providerKind) {
      const kind = t.provider?.kind ?? 'none'
      if (kind !== filter.providerKind) continue
    }
    if (filter.isStream !== undefined && t.isStream !== filter.isStream) continue
    const item: TaskListItem = {
      id: t.id,
      name: t.name,
      state: t.state,
      threadId: t.threadId,
      transientState: t.transientState,
      membrane: t.membrane,
      isStream: t.isStream,
      childCount: liveCount(g, g.children.get(t.id)),
      parentCount: liveCount(g, g.parents.get(t.id))
    }
    if (t.provider) item.provider = structuredClone(t.provider)
    out.push(item)
  }
  return out
}
