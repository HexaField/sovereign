// @sovereign/tasks — holonic task ontology for cross-thread task
// coordination. Tasks form a DAG stored in the `hex-tasks` AD4M
// perspective. Sovereign MCP tools wrap the service layer; the
// TaskDigest replaces PresenceDigest for the presence system.

export type {
  Task,
  TaskRef,
  TaskListItem,
  TaskSummary,
  TaskState,
  TaskEventType,
  TaskEventPayload,
  CreateTaskOpts,
  UpdateTaskOpts,
  ListTaskFilter,
  SubscribeFilter
} from './types.js'
export { TASK_STATES, TASK_SHACL_SCHEMA } from './types.js'

export type { TaskStore } from './store.js'
export { createInMemoryTaskStore } from './store.js'

export type { TaskService, TaskServiceDeps } from './service.js'
export { createTaskService } from './service.js'

export { createAd4mTaskStore } from './ad4m-store.js'

export type { TaskDigest, TaskDigestEntry } from './task-digest.js'
export { createTaskDigest } from './task-digest.js'

export type { TaskBootstrapOpts } from './bootstrap.js'
export { bootstrapTaskPerspective } from './bootstrap.js'
