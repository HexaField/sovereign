// Holonic task ontology — type definitions.
//
// Tasks form a DAG (directed acyclic graph). Each task functions as both
// whole and part — many-to-many parent/child relationships. Stored as
// subject-class instances in the `hex-tasks` AD4M perspective.

export type TaskState = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export const TASK_STATES: readonly TaskState[] = ['pending', 'in_progress', 'completed', 'cancelled'] as const

/** Full task record with resolved relationship refs. */
export interface Task {
  id: string
  name: string
  state: TaskState
  threadId: string | null
  description: string | null
  transientState: string | null
  createdAt: string
  updatedAt: string | null
  parentTasks: TaskRef[]
  childTasks: TaskRef[]
  tags: string[]
}

/** Compact reference to a related task (used in parent/child lists). */
export interface TaskRef {
  id: string
  name: string
  state: TaskState
}

/** List-view item — lighter than a full Task. */
export interface TaskListItem {
  id: string
  name: string
  state: TaskState
  threadId: string | null
  transientState: string | null
  childCount: number
  parentCount: number
}

/** Operational snapshot returned by task_summary. */
export interface TaskSummary {
  inFlight: Array<{
    taskId: string
    name: string
    threadId: string | null
    threadLabel?: string
    state: TaskState
    transientState: string | null
  }>
  recentlyCompleted: Array<{
    taskId: string
    name: string
    completedAt: string
    threadLabel?: string
  }>
  unassigned: Array<{
    taskId: string
    name: string
    state: TaskState
    parentCount: number
  }>
}

// ── Bus events ────────────────────────────────────────────────────────

export type TaskEventType =
  | 'task.created'
  | 'task.updated'
  | 'task.state_changed'
  | 'task.reassigned'
  | 'task.transient_updated'
  | 'task.linked'
  | 'task.unlinked'

export interface TaskEventPayload {
  taskId: string
  taskName: string
  threadId: string | null
  sourceThreadId: string
  oldState?: string
  newState?: string
  oldThreadId?: string | null
  newThreadId?: string | null
  transientState?: string
  parentId?: string
  childId?: string
}

// ── Tool parameter shapes ─────────────────────────────────────────────

export interface CreateTaskOpts {
  name: string
  description?: string
  parentTaskIds?: string[]
  tags?: string[]
  /** Assign to calling thread. Defaults to true. */
  autoAssign?: boolean
  /** Thread UUID of the caller (injected by the MCP layer). */
  sourceThreadId: string
}

export interface UpdateTaskOpts {
  state?: TaskState
  transientState?: string
  name?: string
  description?: string
  /** Pass string to reassign, null to unassign, undefined to leave unchanged. */
  threadId?: string | null
  /** Replaces the entire tag set when provided. */
  tags?: string[]
  /** Thread UUID of the caller (injected by the MCP layer). */
  sourceThreadId: string
}

export interface ListTaskFilter {
  state?: TaskState
  threadId?: string | null
  parentId?: string
  rootsOnly?: boolean
}

export interface SubscribeFilter {
  taskId?: string
  threadId?: string
  state?: TaskState
}

// ── SHACL schema ──────────────────────────────────────────────────────

export const TASK_SHACL_SCHEMA = {
  target_class: 'task://Task',
  constructor_actions: [{ action: 'addLink', source: 'this', predicate: 'rdf://type', target: 'task://Task' }],
  destructor_actions: [{ action: 'removeLink', source: 'this', predicate: 'rdf://type', target: 'task://Task' }],
  properties: [
    {
      path: 'task://name',
      name: 'name',
      datatype: 'xsd://string',
      min_count: 1,
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://name', target: 'value' }]
    },
    {
      path: 'task://state',
      name: 'state',
      datatype: 'xsd://string',
      min_count: 1,
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://state', target: 'value' }]
    },
    {
      path: 'task://threadId',
      name: 'threadId',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://threadId', target: 'value' }]
    },
    {
      path: 'task://description',
      name: 'description',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://description', target: 'value' }]
    },
    {
      path: 'task://transientState',
      name: 'transientState',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://transientState', target: 'value' }]
    },
    {
      path: 'task://createdAt',
      name: 'createdAt',
      datatype: 'xsd://string',
      min_count: 1,
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://createdAt', target: 'value' }]
    },
    {
      path: 'task://updatedAt',
      name: 'updatedAt',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: [{ action: 'setSingleTarget', source: 'this', predicate: 'task://updatedAt', target: 'value' }]
    },
    {
      path: 'task://parentTasks',
      name: 'parentTasks',
      node_kind: 'IRI',
      collection: true,
      adder: [{ action: 'addLink', source: 'this', predicate: 'task://parentTasks', target: 'value' }],
      remover: [{ action: 'removeLink', source: 'this', predicate: 'task://parentTasks', target: 'value' }]
    },
    {
      path: 'task://childTasks',
      name: 'childTasks',
      node_kind: 'IRI',
      collection: true,
      adder: [{ action: 'addLink', source: 'this', predicate: 'task://childTasks', target: 'value' }],
      remover: [{ action: 'removeLink', source: 'this', predicate: 'task://childTasks', target: 'value' }]
    },
    {
      path: 'task://tags',
      name: 'tags',
      datatype: 'xsd://string',
      collection: true,
      adder: [{ action: 'addLink', source: 'this', predicate: 'task://tags', target: 'value' }],
      remover: [{ action: 'removeLink', source: 'this', predicate: 'task://tags', target: 'value' }]
    }
  ]
} as const
