// TaskStore — storage abstraction for the holonic task graph.
//
// Two implementations over the same in-memory TaskGraph (graph.ts):
//   - createInMemoryTaskStore()  — process-lifetime only (tests)
//   - createResilientTaskStore() — runtime: AD4M `sovereign-forge` perspective,
//     with an outbox while AD4M is down and a local snapshot for restarts
//
// The TaskService delegates all persistence through this interface.

import path from 'node:path'
import { createAd4mTaskBackend } from './ad4m-store.js'
import type { Durable, DurableStatus } from './durable.js'
import { createDurable } from './durable.js'
import type { TaskGraph, TaskOp } from './graph.js'
import {
  ancestors,
  applyTaskOp,
  emptyTaskGraph,
  findByProviderKey,
  listTasks,
  normalizeTaskOp,
  readTask,
  taskGraphFromData,
  taskGraphToData,
  taskGraphToOps
} from './graph.js'
import type { LinkGraph } from './link-graph.js'
import type { ListTaskFilter, Task, TaskFields, TaskListItem, TaskRecord } from './types.js'

export interface TaskStore {
  /** Create a new task. Returns the created task. */
  create(task: TaskRecord): Promise<Task>
  /** Get a task by id with resolved parent/child refs. Returns null when absent. */
  get(id: string): Promise<Task | null>
  /** List tasks, optionally filtered. */
  list(filter?: ListTaskFilter): Promise<TaskListItem[]>
  /** Update fields on a task. Returns the updated task. */
  update(id: string, fields: TaskFields): Promise<Task>
  /** Add a parent/child link. */
  addLink(parentId: string, childId: string): Promise<void>
  /** Remove a parent/child link. */
  removeLink(parentId: string, childId: string): Promise<void>
  /** Walk ancestors of a task (for cycle detection). Returns set of ancestor ids. */
  ancestors(taskId: string): Promise<Set<string>>
  /** The task whose provider key (refKey or "plan:<project>/<path>") is `key`. */
  findByProviderKey(key: string): Promise<Task | null>
  /** Persistence state; in-memory stores report backend 'off'. */
  status(): DurableStatus
  /** Resolves once the store has finished its first load attempt. */
  settled(): Promise<void>
  /** Replay pending writes and load from the backend now (no-op without one). */
  sync(): Promise<void>
  /** Dispose resources. */
  dispose(): void
}

/** A TaskStore over a TaskGraph that some `write` keeps current. */
function createGraphStore(deps: {
  graph: () => TaskGraph
  write: (op: TaskOp) => void
  status: () => DurableStatus
  settled: () => Promise<void>
  sync: () => Promise<void>
  dispose: () => void
}): TaskStore {
  const { graph, write } = deps

  function mustGet(id: string): Task {
    const t = readTask(graph(), id)
    if (!t) throw new Error(`Task not found: ${id}`)
    return t
  }

  return {
    async create(task) {
      if (graph().tasks.has(task.id)) throw new Error(`Task already exists: ${task.id}`)
      write({ type: 'task.put', task: { ...task, tags: [...task.tags] } })
      return mustGet(task.id)
    },

    async get(id) {
      return readTask(graph(), id)
    },

    async list(filter) {
      return listTasks(graph(), filter)
    },

    async update(id, fields) {
      mustGet(id)
      const clean: TaskFields = {}
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) (clean as Record<string, unknown>)[k] = v
      if (Object.keys(clean).length > 0) write({ type: 'task.update', id, fields: clean })
      return mustGet(id)
    },

    async addLink(parentId, childId) {
      const g = graph()
      if (!g.tasks.has(parentId)) throw new Error(`Parent task not found: ${parentId}`)
      if (!g.tasks.has(childId)) throw new Error(`Child task not found: ${childId}`)
      if (g.children.get(parentId)?.has(childId)) return
      write({ type: 'link.add', parentId, childId })
    },

    async removeLink(parentId, childId) {
      if (!graph().children.get(parentId)?.has(childId)) return
      write({ type: 'link.remove', parentId, childId })
    },

    async ancestors(taskId) {
      return ancestors(graph(), taskId)
    },

    async findByProviderKey(key) {
      const rec = findByProviderKey(graph(), key)
      return rec ? readTask(graph(), rec.id) : null
    },

    status: deps.status,
    settled: deps.settled,
    sync: deps.sync,
    dispose: deps.dispose
  }
}

// ── In-memory implementation ──────────────────────────────────────────

export function createInMemoryTaskStore(): TaskStore {
  let g = emptyTaskGraph()
  return createGraphStore({
    graph: () => g,
    write: (op) => applyTaskOp(g, op),
    status: () => ({ backend: 'off', loadedFromBackend: false, pending: 0, deadLettered: 0 }),
    settled: async () => {},
    sync: async () => {},
    dispose: () => {
      g = emptyTaskGraph()
    }
  })
}

// ── Resilient (AD4M + outbox + snapshot) implementation ───────────────

export interface ResilientStoreOptions {
  /** Directory for outbox.jsonl, snapshot.json (normally <dataDir>/tasks). */
  dir: string
  /** Opens the perspective; throws while AD4M is unreachable. null = local only. */
  connect: (() => Promise<LinkGraph>) | null
  /** AD4M reconnect signal. */
  onReconnect?: (cb: () => void) => () => void
  retryMs?: number
  callTimeoutMs?: number
  snapshotDelayMs?: number
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export const TASK_OUTBOX_FILE = 'outbox.jsonl'
export const TASK_SNAPSHOT_FILE = 'snapshot.json'

export function createTaskDurable(opts: ResilientStoreOptions): Durable<TaskGraph, TaskOp> {
  const connect = opts.connect
  return createDurable<TaskGraph, TaskOp>({
    name: 'tasks',
    dir: opts.dir,
    outboxFile: TASK_OUTBOX_FILE,
    snapshotFile: TASK_SNAPSHOT_FILE,
    connect: connect ? async () => createAd4mTaskBackend(await connect()) : null,
    onReconnect: opts.onReconnect,
    empty: emptyTaskGraph,
    apply: applyTaskOp,
    serialize: taskGraphToData,
    deserialize: (raw) => taskGraphFromData(raw as never),
    reviveOp: normalizeTaskOp,
    seedOps: taskGraphToOps,
    isEmpty: (g) => g.tasks.size === 0,
    retryMs: opts.retryMs,
    callTimeoutMs: opts.callTimeoutMs,
    snapshotDelayMs: opts.snapshotDelayMs,
    log: opts.log
  })
}

/** The runtime TaskStore: reads from memory, writes through to AD4M, queues
 *  writes in `<dir>/outbox.jsonl` while AD4M is unreachable, and restarts
 *  from `<dir>/snapshot.json` when AD4M is down at boot. */
export function createResilientTaskStore(opts: ResilientStoreOptions): TaskStore {
  const durable = createTaskDurable(opts)
  return createGraphStore({
    graph: durable.state,
    write: durable.write,
    status: durable.status,
    settled: durable.settled,
    sync: durable.sync,
    dispose: durable.dispose
  })
}

/** Default file locations under a Sovereign data dir. */
export function taskStoreDir(dataDir: string): string {
  return path.join(dataDir, 'tasks')
}
