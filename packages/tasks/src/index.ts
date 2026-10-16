// @sovereign/tasks — holonic task graph for cross-thread task coordination
// and the Forge work graph. Tasks form a DAG persisted in the
// `sovereign-forge` AD4M perspective (with an outbox and a local snapshot
// while AD4M is down). Sovereign MCP tools wrap the service layer; the
// TaskDigest feeds the presence system.

export type {
  Task,
  TaskRecord,
  TaskFields,
  TaskProvider,
  ChangeProvider,
  IssueProvider,
  PlanProvider,
  LegacyGithubPrProvider,
  ProviderKind,
  ChecksStatus,
  ReviewDecision,
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
export {
  TASK_STATES,
  PROVIDER_KINDS,
  normalizeProvider,
  providerKey,
  providerRepos,
  planKey,
  parsePlanKey
} from './types.js'

export type { TaskStore, ResilientStoreOptions } from './store.js'
export {
  createInMemoryTaskStore,
  createResilientTaskStore,
  taskStoreDir,
  TASK_OUTBOX_FILE,
  TASK_SNAPSHOT_FILE
} from './store.js'

export type { DurableStatus } from './durable.js'

export type { TaskService, TaskServiceDeps, EnsureTaskInit, CreateStreamOpts } from './service.js'
export { createTaskService } from './service.js'

export type { LinkGraph, LinkTriple, LinkPattern } from './link-graph.js'
export { createInMemoryLinkGraph } from './link-graph.js'
export { FORGE_PERSPECTIVE_NAME, FORGE_SHACL_CLASSES } from './ontology.js'
export type { ForgePerspective, ForgePerspectiveOptions } from './ad4m-perspective.js'
export { createForgePerspective } from './ad4m-perspective.js'

export type {
  ForgeMetaStore,
  ForgeMetaStoreOptions,
  RelatedEdge,
  RelatedEdgeSource,
  StoredView,
  SaveViewInput,
  AddEdgeInput
} from './meta.js'
export { createForgeMetaStore, META_OUTBOX_FILE, META_SNAPSHOT_FILE } from './meta.js'

export type { ForgePersistence, ForgePersistenceOptions } from './bootstrap.js'
export { createForgePersistence } from './bootstrap.js'

export type { TaskDigest, TaskDigestEntry } from './task-digest.js'
export { createTaskDigest } from './task-digest.js'

export type { ForgeTaskPortDeps } from './forge-port.js'
export { createForgeTaskPort, statusOf, withStatus, toPortTask } from './forge-port.js'

export type { ImportTarget, ImportInput, ImportOpts, ImportResult, TaskImporter, TaskImporterDeps } from './import.js'
export { parseImportTarget, parseForgeUrl, createTaskImporter } from './import.js'

export type { TaskRouteDeps } from './routes.js'
export { createTaskRoutes } from './routes.js'
