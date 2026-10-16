// An in-memory TaskPort for the work graph's own tests. The server binds the
// real one (@sovereign/tasks createForgeTaskPort); task-port.contract.test.ts
// holds both to the same contract. With `bus` it emits the task.* events
// TaskService emits.

import crypto from 'node:crypto'
import type { EventBus, ForgeView, WorkEdgeKind, WorkStream } from '@sovereign/core'
import type { PortTask, PortTaskState, PortTaskStatus, RelatedEdgeRecord, TaskInit, TaskPort } from './types.js'

export interface MemoryTaskPortOpts {
  bus?: EventBus
  now?: () => number
  /** Source tag on emitted events. */
  source?: string
}

export interface MemoryTaskPort extends TaskPort {
  /** Create a task with no forge item (a decision, a purchase). */
  createTask(membrane: string | null, name: string, parentId?: string): Promise<PortTask>
  /** Create a task for a forge key with no membrane (an import from a thread outside every membrane). */
  importTask(key: string, kind: 'change' | 'issue', name: string, threadId?: string): Promise<PortTask>
  all(): PortTask[]
}

export function createMemoryTaskPort(opts: MemoryTaskPortOpts = {}): MemoryTaskPort {
  const now = () => new Date((opts.now ?? Date.now)()).toISOString()
  const tasks = new Map<string, PortTask>()
  const views = new Map<string, ForgeView[]>()
  const related = new Map<string, RelatedEdgeRecord[]>()

  function emit(type: string, t: PortTask, extra: Record<string, unknown> = {}) {
    opts.bus?.emit({
      type,
      timestamp: now(),
      source: 'tasks',
      payload: {
        taskId: t.id,
        taskName: t.name,
        threadId: t.threadId,
        sourceThreadId: opts.source ?? 'forge',
        ...extra
      }
    })
  }

  function must(id: string): PortTask {
    const t = tasks.get(id)
    if (!t) throw new Error(`Task not found: ${id}`)
    return t
  }

  function make(
    membrane: string | null,
    name: string,
    key: string | null,
    isStream: boolean,
    kind?: PortTask['kind']
  ): PortTask {
    const at = now()
    const t: PortTask = {
      id: `task://${crypto.randomUUID()}`,
      name,
      state: 'pending',
      threadId: null,
      transientState: null,
      membrane,
      key,
      ...(kind ? { kind } : {}),
      parentIds: [],
      childIds: [],
      isStream,
      createdAt: at,
      updatedAt: at
    }
    tasks.set(t.id, t)
    return t
  }

  function link(parentId: string, childId: string) {
    const p = must(parentId)
    const c = must(childId)
    if (parentId === childId) throw new Error('A task cannot be its own parent')
    // No cycles: the parent must not descend from the child.
    const stack = [childId]
    const seen = new Set<string>()
    while (stack.length) {
      const id = stack.pop()!
      if (id === parentId) throw new Error('Link would create a cycle')
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(tasks.get(id)?.childIds ?? []))
    }
    if (!p.childIds.includes(childId)) p.childIds.push(childId)
    if (!c.parentIds.includes(parentId)) c.parentIds.push(parentId)
  }

  const stream = (t: PortTask): WorkStream => {
    const parentId = t.parentIds.find((p) => tasks.get(p)?.isStream)
    return {
      id: t.id,
      name: t.name,
      membrane: t.membrane ?? '',
      ...(parentId ? { parentId } : {}),
      memberCount: t.childIds.length
    }
  }

  const sameEdge = (e: RelatedEdgeRecord, from: string, to: string, kind: WorkEdgeKind) =>
    e.from === from && e.to === to && e.kind === kind

  const byKey = (key: string) => [...tasks.values()].find((t) => t.key === key)

  return {
    async ensureTask(key: string, init: TaskInit) {
      const found = byKey(key)
      if (found) {
        if (init.stream) found.isStream = true
        found.membrane ??= init.membrane
        return found
      }
      const t = make(init.membrane, init.name, key, Boolean(init.stream), init.kind)
      emit('task.created', t)
      return t
    },
    async createTask(membrane, name, parentId) {
      const t = make(membrane, name, null, false)
      if (parentId) link(parentId, t.id)
      emit('task.created', t)
      return t
    },
    async importTask(key, kind, name, threadId) {
      const t = make(null, name, key, false, kind)
      if (threadId) t.threadId = threadId
      emit('task.created', t)
      return t
    },
    async get(id) {
      return tasks.get(id)
    },
    async findByKey(key) {
      return byKey(key)
    },
    async setThread(id, threadId) {
      const t = must(id)
      if (t.threadId === threadId) return
      const old = t.threadId
      t.threadId = threadId
      t.updatedAt = now()
      emit('task.reassigned', t, { oldThreadId: old, newThreadId: threadId })
    },
    async setState(id, state: PortTaskState) {
      const t = must(id)
      if (t.state === state) return
      const old = t.state
      t.state = state
      t.updatedAt = now()
      emit('task.state_changed', t, { oldState: old, newState: state })
    },
    async setTransientState(id, text) {
      const t = must(id)
      if (t.transientState === text) return
      t.transientState = text
      t.updatedAt = now()
      emit('task.transient_updated', t, { transientState: text ?? undefined })
    },
    async setStatus(id, status: PortTaskStatus) {
      const t = must(id)
      if (!t.key) throw new Error(`Task ${id} has no forge item`)
      t.status = status
      emit('task.provider_updated', t)
    },
    async listByMembrane(membrane) {
      return [...tasks.values()].filter((t) => t.membrane === membrane)
    },
    async listForgeItems() {
      return [...tasks.values()].filter((t) => t.kind === 'change' || t.kind === 'issue')
    },
    async streamsOf(membrane) {
      return [...tasks.values()].filter((t) => t.isStream && t.membrane === membrane).map(stream)
    },
    async createStream(membrane, name, parentId) {
      if (parentId && !tasks.get(parentId)?.isStream) throw new Error(`Not a work stream: ${parentId}`)
      const t = make(membrane, name, null, true)
      if (parentId) link(parentId, t.id)
      emit('task.created', t)
      return stream(t)
    },
    async addToStream(streamId, taskId) {
      if (!must(streamId).isStream) throw new Error(`Not a work stream: ${streamId}`)
      if (must(taskId).parentIds.includes(streamId)) return
      link(streamId, taskId)
      emit('task.linked', must(taskId), { parentId: streamId, childId: taskId })
    },
    async removeFromStream(streamId, taskId) {
      const s = must(streamId)
      const t = must(taskId)
      s.childIds = s.childIds.filter((c) => c !== taskId)
      t.parentIds = t.parentIds.filter((p) => p !== streamId)
      emit('task.unlinked', t, { parentId: streamId, childId: taskId })
    },
    async getViews(membrane) {
      return structuredClone(views.get(membrane) ?? [])
    },
    async putViews(membrane, list) {
      views.set(membrane, structuredClone(list))
      return structuredClone(list)
    },
    async listRelated(membrane) {
      return (related.get(membrane) ?? []).map((e) => ({ ...e }))
    },
    async addRelated(membrane, edge) {
      const list = related.get(membrane) ?? []
      const existing = list.find((e) => sameEdge(e, edge.from, edge.to, edge.kind))
      if (existing) return { ...existing }
      const rec: RelatedEdgeRecord = { ...edge, accepted: false, createdAt: now() }
      list.push(rec)
      related.set(membrane, list)
      return { ...rec }
    },
    async acceptRelated(membrane, from, to, kind) {
      const e = (related.get(membrane) ?? []).find((x) => sameEdge(x, from, to, kind))
      if (!e) return false
      e.accepted = true
      return true
    },
    async deleteRelated(membrane, from, to, kind) {
      const list = related.get(membrane) ?? []
      const next = list.filter((x) => !sameEdge(x, from, to, kind))
      if (next.length === list.length) return false
      related.set(membrane, next)
      return true
    },
    all: () => [...tasks.values()]
  }
}
