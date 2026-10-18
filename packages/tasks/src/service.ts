// TaskService — business logic for the holonic task graph.
//
// Wraps TaskStore with:
//   - Bus event emission on every mutation
//   - Thread awareness (sourceThreadId on all events)
//   - Cycle detection on link operations
//   - Operational summary computation
//
// The service emits typed events on the EventBus; the TaskDigest and
// waker subscriptions consume them downstream.

import { randomUUID } from 'node:crypto'
import type { EventBus, WorkStream } from '@sovereign/core'
import type { DurableStatus } from './durable.js'
import type { TaskStore } from './store.js'
import type {
  Task,
  TaskListItem,
  TaskSummary,
  TaskState,
  TaskEventType,
  TaskEventPayload,
  CreateTaskOpts,
  UpdateTaskOpts,
  ListTaskFilter
} from './types.js'
import { TASK_STATES, normalizeProvider, parsePlanKey, providerKey } from './types.js'

export interface TaskServiceDeps {
  store: TaskStore
  bus: EventBus
}

export interface TaskService {
  create(opts: CreateTaskOpts): Promise<Task>
  update(taskId: string, opts: UpdateTaskOpts): Promise<Task>
  get(taskId: string): Promise<Task | null>
  list(filter?: ListTaskFilter): Promise<TaskListItem[]>
  link(parentId: string, childId: string, sourceThreadId: string): Promise<void>
  unlink(parentId: string, childId: string, sourceThreadId: string): Promise<void>
  summary(resolveLabel?: (threadId: string) => string | undefined): Promise<TaskSummary>
  /** The task for a provider key (refKey string or "plan:<project>/<path>"), or null. */
  findByProviderKey(key: string): Promise<Task | null>
  /** Idempotent: the task for `key`, created from `init` when there is none.
   *  Parent links in `init.parentTaskIds` are added either way. A plan key
   *  needs no provider in `init`; a forge key does. */
  ensureTask(key: string, init: EnsureTaskInit): Promise<{ task: Task; created: boolean }>
  /** Create a work stream (a task flagged isStream, unassigned). */
  createStream(opts: CreateStreamOpts): Promise<Task>
  /** Add a task to a stream (a subtask link under the stream). A PR or issue leaves any other stream it was in. */
  addToStream(streamId: string, taskId: string, sourceThreadId: string): Promise<void>
  removeFromStream(streamId: string, taskId: string, sourceThreadId: string): Promise<void>
  /** Streams, optionally of one membrane. memberCount counts direct members. */
  listStreams(membrane?: string): Promise<WorkStream[]>
  /** Persistence state of the underlying store. */
  storeStatus(): DurableStatus
  dispose(): void
}

export type EnsureTaskInit = Omit<CreateTaskOpts, 'provider'> & {
  provider?: CreateTaskOpts['provider']
}

export interface CreateStreamOpts {
  name: string
  description?: string
  membrane?: string | null
  /** Parent streams (streams nest). */
  parentStreamIds?: string[]
  tags?: string[]
  sourceThreadId: string
}

function emit(bus: EventBus, type: TaskEventType, payload: TaskEventPayload): void {
  bus.emit({
    type,
    timestamp: new Date().toISOString(),
    source: 'tasks',
    payload
  })
}

function validateState(state: string): asserts state is TaskState {
  if (!TASK_STATES.includes(state as TaskState)) {
    throw new Error(`Invalid task state: "${state}". Valid states: ${TASK_STATES.join(', ')}`)
  }
}

/**
 * A PR or issue task belongs to at most one work stream (its owning epic).
 * Task-only tasks, plans and sub-streams may sit in several.
 */
export function ownedByOneStream(t: Pick<Task, 'isStream' | 'provider'>): boolean {
  return !t.isStream && (t.provider?.kind === 'change' || t.provider?.kind === 'issue')
}

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { store, bus } = deps
  // ensureTask is check-then-create; serialise it per key.
  const ensureLocks = new Map<string, Promise<unknown>>()

  async function createTask(opts: CreateTaskOpts): Promise<Task> {
    const provider = opts.provider === undefined ? undefined : normalizeProvider(opts.provider)
    if (opts.provider !== undefined && !provider) throw new Error('Unrecognised task provider')
    if (provider) {
      const existing = await store.findByProviderKey(providerKey(provider))
      if (existing) throw new Error(`A task for ${providerKey(provider)} already exists: ${existing.id}`)
    }
    for (const parentId of opts.parentTaskIds ?? []) {
      if (!(await store.get(parentId))) throw new Error(`Parent task not found: ${parentId}`)
    }
    if (opts.state !== undefined) validateState(opts.state)

    const now = new Date().toISOString()
    const id = `task://${randomUUID()}`
    const threadId = (opts.autoAssign ?? true) ? opts.sourceThreadId : null

    let task = await store.create({
      id,
      name: opts.name,
      state: opts.state ?? 'pending',
      threadId,
      description: opts.description ?? null,
      transientState: null,
      createdAt: now,
      updatedAt: null,
      tags: opts.tags ?? [],
      membrane: opts.membrane ?? null,
      isStream: opts.isStream ?? false,
      ...(provider ? { provider } : {})
    })

    if (opts.parentTaskIds?.length) {
      // A PR or issue has one owning stream: of several stream parents, the last one given wins.
      const owned = ownedByOneStream(task)
      const parents = await Promise.all(opts.parentTaskIds.map((p) => store.get(p)))
      const lastStream = owned ? parents.map((p) => p?.isStream).lastIndexOf(true) : -1
      for (const [i, parentId] of opts.parentTaskIds.entries()) {
        if (lastStream >= 0 && parents[i]?.isStream && i !== lastStream) continue
        await store.addLink(parentId, id)
      }
      task = (await store.get(id)) ?? task
    }

    emit(bus, 'task.created', {
      taskId: id,
      taskName: opts.name,
      threadId,
      sourceThreadId: opts.sourceThreadId
    })
    return task
  }

  async function linkTasks(parentId: string, childId: string, sourceThreadId: string): Promise<void> {
    const parent = await store.get(parentId)
    if (!parent) throw new Error(`Parent task not found: ${parentId}`)
    const child = await store.get(childId)
    if (!child) throw new Error(`Child task not found: ${childId}`)

    // Self-link guard
    if (parentId === childId) throw new Error('Cannot link a task to itself')

    // Cycle detection: walk ancestors of parentId — reject when childId appears
    const parentAncestors = await store.ancestors(parentId)
    if (parentAncestors.has(childId)) {
      throw new Error(`Cycle detected: "${child.name}" already appears as an ancestor of "${parent.name}"`)
    }
    if (child.parentTasks.some((p) => p.id === parentId)) return

    // A PR or issue has one owning stream: joining one leaves the others.
    if (parent.isStream && ownedByOneStream(child)) {
      for (const p of child.parentTasks) {
        if ((await store.get(p.id))?.isStream) await unlinkTasks(p.id, childId, sourceThreadId)
      }
    }
    await store.addLink(parentId, childId)

    emit(bus, 'task.linked', {
      taskId: childId,
      taskName: child.name,
      threadId: child.threadId,
      sourceThreadId,
      parentId,
      childId
    })
  }

  async function unlinkTasks(parentId: string, childId: string, sourceThreadId: string): Promise<void> {
    const child = await store.get(childId)
    await store.removeLink(parentId, childId)

    emit(bus, 'task.unlinked', {
      taskId: childId,
      taskName: child?.name ?? childId,
      threadId: child?.threadId ?? null,
      sourceThreadId,
      parentId,
      childId
    })
  }

  async function mustBeStream(streamId: string): Promise<Task> {
    const stream = await store.get(streamId)
    if (!stream) throw new Error(`Stream not found: ${streamId}`)
    if (!stream.isStream) throw new Error(`Task ${streamId} is not a work stream`)
    return stream
  }

  return {
    create: createTask,

    async update(taskId, opts) {
      const existing = await store.get(taskId)
      if (!existing) throw new Error(`Task not found: ${taskId}`)

      const now = new Date().toISOString()
      const fields: Record<string, unknown> = { updatedAt: now }

      // Collect which fields change
      let stateChanged = false
      let threadChanged = false
      let transientChanged = false

      if (opts.state !== undefined && opts.state !== existing.state) {
        validateState(opts.state)
        fields.state = opts.state
        stateChanged = true
      }
      if (opts.name !== undefined) fields.name = opts.name
      if (opts.description !== undefined) fields.description = opts.description
      if (opts.tags !== undefined) fields.tags = opts.tags

      if (opts.threadId !== undefined && opts.threadId !== existing.threadId) {
        fields.threadId = opts.threadId
        threadChanged = true
      }

      if (opts.transientState !== undefined && opts.transientState !== existing.transientState) {
        fields.transientState = opts.transientState
        transientChanged = true
      }

      if (opts.membrane !== undefined) fields.membrane = opts.membrane
      if (opts.isStream !== undefined) fields.isStream = opts.isStream

      let providerChanged = false
      if (opts.provider !== undefined) {
        const provider = normalizeProvider(opts.provider)
        if (!provider) throw new Error('Unrecognised task provider')
        const key = providerKey(provider)
        const holder = await store.findByProviderKey(key)
        if (holder && holder.id !== taskId) throw new Error(`A task for ${key} already exists: ${holder.id}`)
        fields.provider = provider
        providerChanged = true
      }

      const updated = await store.update(taskId, fields as any)

      // Emit specific events for state, thread, transient changes
      if (stateChanged) {
        emit(bus, 'task.state_changed', {
          taskId,
          taskName: updated.name,
          threadId: updated.threadId,
          sourceThreadId: opts.sourceThreadId,
          oldState: existing.state,
          newState: updated.state
        })
      }

      if (threadChanged) {
        emit(bus, 'task.reassigned', {
          taskId,
          taskName: updated.name,
          threadId: updated.threadId,
          sourceThreadId: opts.sourceThreadId,
          oldThreadId: existing.threadId,
          newThreadId: updated.threadId
        })
      }

      if (transientChanged) {
        emit(bus, 'task.transient_updated', {
          taskId,
          taskName: updated.name,
          threadId: updated.threadId,
          sourceThreadId: opts.sourceThreadId,
          transientState: updated.transientState ?? undefined
        })
      }

      if (providerChanged) {
        emit(bus, 'task.provider_updated', {
          taskId,
          taskName: updated.name,
          threadId: updated.threadId,
          sourceThreadId: opts.sourceThreadId
        })
      }

      // Generic update event for non-specific changes
      if (!stateChanged && !threadChanged && !transientChanged && !providerChanged) {
        emit(bus, 'task.updated', {
          taskId,
          taskName: updated.name,
          threadId: updated.threadId,
          sourceThreadId: opts.sourceThreadId
        })
      }

      return updated
    },

    async get(taskId) {
      return store.get(taskId)
    },

    async list(filter) {
      return store.list(filter)
    },

    link: linkTasks,
    unlink: unlinkTasks,

    async findByProviderKey(key) {
      return store.findByProviderKey(key)
    },

    async ensureTask(key, init) {
      const prior = ensureLocks.get(key) ?? Promise.resolve()
      const run = prior
        .catch(() => {})
        .then(async () => {
          const existing = await store.findByProviderKey(key)
          if (existing) {
            for (const parentId of init.parentTaskIds ?? []) {
              await linkTasks(parentId, existing.id, init.sourceThreadId)
            }
            return { task: (await store.get(existing.id)) ?? existing, created: false }
          }
          let provider = init.provider === undefined ? undefined : normalizeProvider(init.provider)
          if (!provider) {
            const plan = parsePlanKey(key)
            if (!plan) throw new Error(`No task for ${key}, and no provider to create one`)
            provider = { kind: 'plan', project: plan.project, path: plan.path, status: 'planned' }
          }
          if (providerKey(provider) !== key) {
            throw new Error(`Provider key ${providerKey(provider)} does not match ${key}`)
          }
          return { task: await createTask({ ...init, provider }), created: true }
        })
      ensureLocks.set(key, run)
      try {
        return await run
      } finally {
        if (ensureLocks.get(key) === run) ensureLocks.delete(key)
      }
    },

    async createStream(opts) {
      for (const parentId of opts.parentStreamIds ?? []) await mustBeStream(parentId)
      return createTask({
        name: opts.name,
        description: opts.description,
        membrane: opts.membrane ?? null,
        tags: opts.tags,
        parentTaskIds: opts.parentStreamIds,
        isStream: true,
        autoAssign: false,
        sourceThreadId: opts.sourceThreadId
      })
    },

    async addToStream(streamId, taskId, sourceThreadId) {
      await mustBeStream(streamId)
      await linkTasks(streamId, taskId, sourceThreadId)
    },

    async removeFromStream(streamId, taskId, sourceThreadId) {
      await mustBeStream(streamId)
      await unlinkTasks(streamId, taskId, sourceThreadId)
    },

    async listStreams(membrane) {
      const streams = await store.list({ isStream: true, ...(membrane !== undefined ? { membrane } : {}) })
      const out: WorkStream[] = []
      for (const s of streams) {
        const full = await store.get(s.id)
        if (!full) continue
        const parent = full.parentTasks.find((p) => streams.some((x) => x.id === p.id))
        out.push({
          id: s.id,
          name: s.name,
          membrane: s.membrane ?? '',
          ...(parent ? { parentId: parent.id } : {}),
          memberCount: s.childCount,
          ...(s.state === 'cancelled' ? { archived: true } : {}),
          ...(s.provider?.kind === 'plan' ? { plan: providerKey(s.provider) } : {})
        })
      }
      return out
    },

    storeStatus() {
      return store.status()
    },

    async summary(resolveLabel) {
      const all = await store.list()

      const inFlight = all
        .filter((t) => t.state === 'pending' || t.state === 'in_progress')
        .map((t) => ({
          taskId: t.id,
          name: t.name,
          threadId: t.threadId,
          threadLabel: t.threadId ? resolveLabel?.(t.threadId) : undefined,
          state: t.state,
          transientState: t.transientState
        }))

      // Recently completed: completed tasks, sorted newest first, capped at 10.
      // Since TaskListItem lacks updatedAt, fetch full tasks for completed ones.
      const completedItems = all.filter((t) => t.state === 'completed')
      const recentlyCompleted: TaskSummary['recentlyCompleted'] = []
      for (const item of completedItems.slice(0, 10)) {
        const full = await store.get(item.id)
        if (full) {
          recentlyCompleted.push({
            taskId: full.id,
            name: full.name,
            completedAt: full.updatedAt ?? full.createdAt,
            threadLabel: full.threadId ? resolveLabel?.(full.threadId) : undefined
          })
        }
      }

      const unassigned = all
        .filter((t) => t.threadId === null && (t.state === 'pending' || t.state === 'in_progress'))
        .map((t) => ({
          taskId: t.id,
          name: t.name,
          state: t.state,
          parentCount: t.parentCount
        }))

      return { inFlight, recentlyCompleted, unassigned }
    },

    dispose() {
      store.dispose()
    }
  }
}
