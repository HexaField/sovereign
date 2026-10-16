// AD4M task backend — TaskOps as link mutations on the `sovereign-forge`
// perspective, and the whole task graph loaded back from its links.
//
// Every op is idempotent on the perspective: a property write removes the
// property's links before adding the new one, and a subtask link is removed
// before it is added, so replaying an op (after a crash mid-replay) never
// leaves duplicate links.

import type { DurableBackend } from './durable.js'
import type { TaskGraph, TaskOp } from './graph.js'
import { applyTaskOp, emptyTaskGraph, normalizeRecord } from './graph.js'
import type { LinkGraph, LinkPattern, LinkTriple } from './link-graph.js'
import { fromLiteral, toLiteral } from './link-graph.js'
import { P, RDF_TYPE, T } from './ontology.js'
import type { TaskFields, TaskRecord, TaskState } from './types.js'
import { normalizeProvider, providerKey } from './types.js'

type ScalarField =
  | 'name'
  | 'state'
  | 'transientState'
  | 'description'
  | 'createdAt'
  | 'updatedAt'
  | 'threadId'
  | 'membrane'

const SCALARS: Array<[ScalarField, string]> = [
  ['name', P.name],
  ['state', P.state],
  ['transientState', P.transientState],
  ['description', P.description],
  ['createdAt', P.createdAt],
  ['updatedAt', P.updatedAt],
  ['threadId', P.threadId],
  ['membrane', P.membrane]
]

/** Link mutations that set the given fields on task `id`. */
function fieldMutations(id: string, fields: TaskFields & { createdAt?: string }) {
  const add: LinkTriple[] = []
  const removeMatching: LinkPattern[] = []
  for (const [field, predicate] of SCALARS) {
    const value = (fields as Record<string, string | null | undefined>)[field]
    if (value === undefined) continue
    removeMatching.push({ source: id, predicate })
    if (value !== null) add.push({ source: id, predicate, target: toLiteral(value) })
  }
  if (fields.tags !== undefined) {
    removeMatching.push({ source: id, predicate: P.tag })
    for (const tag of new Set(fields.tags)) add.push({ source: id, predicate: P.tag, target: toLiteral(tag) })
  }
  if (fields.provider !== undefined) {
    for (const predicate of [P.provider, P.providerKind, P.providerKey]) removeMatching.push({ source: id, predicate })
    if (fields.provider) {
      add.push(
        { source: id, predicate: P.provider, target: toLiteral(JSON.stringify(fields.provider)) },
        { source: id, predicate: P.providerKind, target: toLiteral(fields.provider.kind) },
        { source: id, predicate: P.providerKey, target: toLiteral(providerKey(fields.provider)) }
      )
    }
  }
  if (fields.isStream !== undefined) {
    removeMatching.push({ source: id, predicate: RDF_TYPE, target: T.WorkStream })
    if (fields.isStream) add.push({ source: id, predicate: RDF_TYPE, target: T.WorkStream })
  }
  return { add, removeMatching }
}

export function taskOpMutations(op: TaskOp): { add: LinkTriple[]; removeMatching: LinkPattern[] } {
  switch (op.type) {
    case 'task.put': {
      const t = op.task
      const m = fieldMutations(t.id, { ...t, provider: t.provider ?? null } as TaskFields)
      m.removeMatching.push({ source: t.id, predicate: RDF_TYPE, target: T.Task })
      m.add.push({ source: t.id, predicate: RDF_TYPE, target: T.Task })
      return m
    }
    case 'task.update':
      return fieldMutations(op.id, op.fields)
    case 'link.add': {
      const link = { source: op.parentId, predicate: P.subtask, target: op.childId }
      return { add: [link], removeMatching: [link] }
    }
    case 'link.remove':
      return { add: [], removeMatching: [{ source: op.parentId, predicate: P.subtask, target: op.childId }] }
  }
}

/** Rebuild the task graph from the perspective's links. */
export function taskGraphFromLinks(links: LinkTriple[]): TaskGraph {
  const g = emptyTaskGraph()
  const ids = new Set<string>()
  const streams = new Set<string>()
  for (const l of links) {
    if (l.predicate !== RDF_TYPE) continue
    if (l.target === T.Task) ids.add(l.source)
    else if (l.target === T.WorkStream) streams.add(l.source)
  }

  const raw = new Map<string, Record<string, unknown> & { tags: string[] }>()
  for (const id of ids) raw.set(id, { tags: [] })
  const byPredicate = new Map(SCALARS.map(([field, predicate]) => [predicate, field]))
  const subtasks: Array<[string, string]> = []

  for (const l of links) {
    if (l.predicate === P.subtask) {
      subtasks.push([l.source, l.target])
      continue
    }
    const rec = raw.get(l.source)
    if (!rec) continue
    const field = byPredicate.get(l.predicate as never)
    if (field) rec[field] = fromLiteral(l.target)
    else if (l.predicate === P.tag) rec.tags.push(fromLiteral(l.target))
    else if (l.predicate === P.provider) {
      try {
        rec.provider = JSON.parse(fromLiteral(l.target))
      } catch {
        /* unreadable provider — the task loads without one */
      }
    }
  }

  for (const [id, rec] of raw) {
    if (typeof rec.name !== 'string') continue
    const record: TaskRecord = normalizeRecord({
      ...(rec as Partial<TaskRecord>),
      id,
      name: rec.name,
      state: (rec.state as TaskState | undefined) ?? 'pending',
      tags: [...new Set(rec.tags)],
      isStream: streams.has(id),
      provider: normalizeProvider(rec.provider)
    })
    g.tasks.set(id, record)
  }
  for (const [parentId, childId] of subtasks) applyTaskOp(g, { type: 'link.add', parentId, childId })
  return g
}

/** A durable backend for the task graph on top of a perspective. */
export function createAd4mTaskBackend(graph: LinkGraph): DurableBackend<TaskGraph, TaskOp> {
  return {
    id: graph.id,
    async load() {
      return taskGraphFromLinks(await graph.all())
    },
    async apply(op) {
      await graph.mutate(taskOpMutations(op))
    },
    ping: () => graph.ping()
  }
}
