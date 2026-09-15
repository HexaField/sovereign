// TaskStore — storage abstraction for the holonic task graph.
//
// Two implementations:
//   - createAd4mTaskStore() — real persistence via AD4M perspective
//   - createInMemoryTaskStore() — fast, deterministic, for tests
//
// The TaskService delegates all persistence through this interface.

import type { Task, TaskListItem, TaskProvider, TaskRef, TaskState } from './types.js'

export interface TaskStore {
  /** Create a new task. Returns the created task. */
  create(task: Omit<Task, 'parentTasks' | 'childTasks'>): Promise<Task>
  /** Get a task by id with resolved parent/child refs. Returns null when absent. */
  get(id: string): Promise<Task | null>
  /** List all tasks, optionally filtered. */
  list(filter?: {
    state?: TaskState
    threadId?: string | null
    parentId?: string
    rootsOnly?: boolean
  }): Promise<TaskListItem[]>
  /** Update scalar properties on a task. Returns the updated task. */
  update(
    id: string,
    fields: Partial<
      Pick<Task, 'name' | 'state' | 'threadId' | 'description' | 'transientState' | 'updatedAt' | 'tags' | 'provider'>
    >
  ): Promise<Task>
  /** Add a parent/child link (bidirectional). */
  addLink(parentId: string, childId: string): Promise<void>
  /** Remove a parent/child link (bidirectional). */
  removeLink(parentId: string, childId: string): Promise<void>
  /** Walk ancestors of a task (for cycle detection). Returns set of ancestor ids. */
  ancestors(taskId: string): Promise<Set<string>>
  /** Dispose resources. */
  dispose(): void
}

// ── In-memory implementation ──────────────────────────────────────────

interface StoredTask {
  id: string
  name: string
  state: TaskState
  threadId: string | null
  description: string | null
  transientState: string | null
  createdAt: string
  updatedAt: string | null
  tags: string[]
  provider?: TaskProvider
  parentIds: Set<string>
  childIds: Set<string>
}

export function createInMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, StoredTask>()

  function resolveRef(id: string): TaskRef | null {
    const t = tasks.get(id)
    if (!t) return null
    return { id: t.id, name: t.name, state: t.state }
  }

  function toTask(stored: StoredTask): Task {
    const parentTasks: TaskRef[] = []
    for (const pid of stored.parentIds) {
      const ref = resolveRef(pid)
      if (ref) parentTasks.push(ref)
    }
    const childTasks: TaskRef[] = []
    for (const cid of stored.childIds) {
      const ref = resolveRef(cid)
      if (ref) childTasks.push(ref)
    }
    const task: Task = {
      id: stored.id,
      name: stored.name,
      state: stored.state,
      threadId: stored.threadId,
      description: stored.description,
      transientState: stored.transientState,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      parentTasks,
      childTasks,
      tags: [...stored.tags]
    }
    if (stored.provider) task.provider = { ...stored.provider }
    return task
  }

  return {
    async create(task) {
      const stored: StoredTask = {
        id: task.id,
        name: task.name,
        state: task.state,
        threadId: task.threadId,
        description: task.description,
        transientState: task.transientState,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        tags: [...task.tags],
        provider: task.provider ? { ...task.provider } : undefined,
        parentIds: new Set(),
        childIds: new Set()
      }
      tasks.set(task.id, stored)
      return toTask(stored)
    },

    async get(id) {
      const stored = tasks.get(id)
      if (!stored) return null
      return toTask(stored)
    },

    async list(filter) {
      const results: TaskListItem[] = []
      for (const stored of tasks.values()) {
        if (filter?.state && stored.state !== filter.state) continue
        if (filter?.threadId !== undefined) {
          if (filter.threadId === null && stored.threadId !== null) continue
          if (filter.threadId !== null && stored.threadId !== filter.threadId) continue
        }
        if (filter?.parentId) {
          if (!stored.parentIds.has(filter.parentId)) continue
        }
        if (filter?.rootsOnly && stored.parentIds.size > 0) continue
        const item: TaskListItem = {
          id: stored.id,
          name: stored.name,
          state: stored.state,
          threadId: stored.threadId,
          transientState: stored.transientState,
          childCount: stored.childIds.size,
          parentCount: stored.parentIds.size
        }
        if (stored.provider) {
          item.provider = {
            kind: stored.provider.kind,
            repo: stored.provider.repo,
            number: stored.provider.number,
            prStatus: stored.provider.prStatus,
            checksStatus: stored.provider.checksStatus,
            reviewDecision: stored.provider.reviewDecision,
            url: stored.provider.url
          }
        }
        results.push(item)
      }
      return results
    },

    async update(id, fields) {
      const stored = tasks.get(id)
      if (!stored) throw new Error(`Task not found: ${id}`)
      if (fields.name !== undefined) stored.name = fields.name
      if (fields.state !== undefined) stored.state = fields.state
      if (fields.threadId !== undefined) stored.threadId = fields.threadId
      if (fields.description !== undefined) stored.description = fields.description
      if (fields.transientState !== undefined) stored.transientState = fields.transientState
      if (fields.updatedAt !== undefined) stored.updatedAt = fields.updatedAt
      if (fields.tags !== undefined) stored.tags = [...fields.tags]
      if (fields.provider !== undefined) stored.provider = fields.provider ? { ...fields.provider } : undefined
      return toTask(stored)
    },

    async addLink(parentId, childId) {
      const parent = tasks.get(parentId)
      const child = tasks.get(childId)
      if (!parent) throw new Error(`Parent task not found: ${parentId}`)
      if (!child) throw new Error(`Child task not found: ${childId}`)
      parent.childIds.add(childId)
      child.parentIds.add(parentId)
    },

    async removeLink(parentId, childId) {
      const parent = tasks.get(parentId)
      const child = tasks.get(childId)
      if (parent) parent.childIds.delete(childId)
      if (child) child.parentIds.delete(parentId)
    },

    async ancestors(taskId) {
      const visited = new Set<string>()
      const queue = [taskId]
      while (queue.length > 0) {
        const current = queue.pop()!
        const stored = tasks.get(current)
        if (!stored) continue
        for (const pid of stored.parentIds) {
          if (!visited.has(pid)) {
            visited.add(pid)
            queue.push(pid)
          }
        }
      }
      return visited
    },

    dispose() {
      tasks.clear()
    }
  }
}
