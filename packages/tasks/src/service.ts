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
import type { EventBus } from '@sovereign/core'
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
import { TASK_STATES } from './types.js'

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
  dispose(): void
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

export function createTaskService(deps: TaskServiceDeps): TaskService {
  const { store, bus } = deps

  return {
    async create(opts) {
      const now = new Date().toISOString()
      const id = `task://${randomUUID()}`
      const threadId = (opts.autoAssign ?? true) ? opts.sourceThreadId : null

      const task = await store.create({
        id,
        name: opts.name,
        state: 'pending',
        threadId,
        description: opts.description ?? null,
        transientState: null,
        createdAt: now,
        updatedAt: null,
        tags: opts.tags ?? []
      })

      // Wire parent links
      if (opts.parentTaskIds?.length) {
        for (const parentId of opts.parentTaskIds) {
          // Verify parent exists
          const parent = await store.get(parentId)
          if (!parent) throw new Error(`Parent task not found: ${parentId}`)
          await store.addLink(parentId, id)
        }
        // Re-read to get updated refs
        const updated = await store.get(id)
        if (updated) {
          emit(bus, 'task.created', {
            taskId: id,
            taskName: opts.name,
            threadId,
            sourceThreadId: opts.sourceThreadId
          })
          return updated
        }
      }

      emit(bus, 'task.created', {
        taskId: id,
        taskName: opts.name,
        threadId,
        sourceThreadId: opts.sourceThreadId
      })
      return task
    },

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

      // Generic update event for non-specific changes
      if (!stateChanged && !threadChanged && !transientChanged) {
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

    async link(parentId, childId, sourceThreadId) {
      // Verify both exist
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

      await store.addLink(parentId, childId)

      emit(bus, 'task.linked', {
        taskId: childId,
        taskName: child.name,
        threadId: child.threadId,
        sourceThreadId,
        parentId,
        childId
      })
    },

    async unlink(parentId, childId, sourceThreadId) {
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
