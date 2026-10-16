// Work graph — the types the service, its ports and its routes share.

import type {
  Change,
  ChecksState,
  ForgeIssue,
  ForgeRef,
  ForgeView,
  WorkEdgeKind,
  WorkNode,
  WorkStream
} from '@sovereign/core'

// ── Config ─────────────────────────────────────────────────────────────

/** `forge` in config.json (packages/config types + defaults + schema). */
export interface ForgeConfig {
  enabled: boolean
  /** The login Forge acts as on each forge (assignee writes). Without one, the adapter's own identity is used. */
  identities: { github?: string }
  /**
   * Plan directories. Absolute paths serve every membrane; relative paths
   * resolve against the membrane's content dir, each of its orgs and each
   * of its projects.
   */
  planDirs: string[]
  /** Extra repos per membrane ("owner/name" or "host/owner/name"), beside those its projects' remotes name. */
  repos: Record<string, string[]>
  /** Words that make a comment needs-agent (besides "@<identity>"). */
  mentions: string[]
  pollOpenMs: number
  pollAllMs: number
  windowDays: number
  /** GitHub REST base for every github.com repo (the wind tunnel's mock). */
  githubApiUrl?: string
  /** GitHub token; default: GITHUB_TOKEN, GH_TOKEN, then `gh auth token`. */
  githubToken?: string
  rethink: { times: string[]; maxJobs: number; tokenBudget: number }
}

export const DEFAULT_FORGE_CONFIG: ForgeConfig = {
  enabled: false,
  identities: {},
  planDirs: ['plans', 'docs/plans', '.specs'],
  repos: {},
  mentions: [],
  pollOpenMs: 120_000,
  pollAllMs: 600_000,
  windowDays: 21,
  rethink: { times: ['08:30', '17:30'], maxJobs: 6, tokenBudget: 200_000 }
}

// ── Task port ──────────────────────────────────────────────────────────

export type PortTaskState = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** Last-known forge status written onto a task (the TaskProvider's status fields). */
export interface PortTaskStatus {
  kind: 'change' | 'issue' | 'plan'
  /** Change state, issue state ("open" / "closed:completed" / "closed:not_planned") or plan state. */
  state: string
  checks?: ChecksState
  failedChecks?: string[]
  review?: 'approved' | 'changes_requested' | 'review_required' | 'none'
  /** Comment count at the last poll (issue + review comments). */
  unresolvedComments?: number
  lastPolledAt: string
}

export interface PortTask {
  id: string
  name: string
  state: PortTaskState
  threadId: string | null
  transientState: string | null
  membrane: string | null
  /** Provider key: refKey(ref) for a change or issue, "plan:<project>/<path>" for a plan; null for a task-only task. */
  key: string | null
  parentIds: string[]
  childIds: string[]
  /** A WorkStream task. */
  isStream: boolean
  status?: PortTaskStatus
  createdAt: string
  updatedAt: string
}

export interface TaskInit {
  name: string
  membrane: string
  kind: 'change' | 'issue' | 'plan'
  url?: string
  ref?: ForgeRef
  plan?: { project: string; path: string }
}

export interface RelatedEdgeRecord {
  from: string
  to: string
  kind: WorkEdgeKind
  reason?: string
  confidence?: number
  source: 'sync' | 'rethink' | 'josh'
  /** Accepted by the user: shown as source 'josh'. */
  accepted: boolean
  createdAt: string
}

/**
 * What the work graph needs from the task graph. The tasks package binds
 * this to TaskService; `createMemoryTaskPort` implements it in memory.
 */
export interface TaskPort {
  /** The task for a provider key, created when missing (idempotent). */
  ensureTask(key: string, init: TaskInit): Promise<PortTask>
  get(taskId: string): Promise<PortTask | undefined>
  findByKey(key: string): Promise<PortTask | undefined>
  setThread(taskId: string, threadId: string | null): Promise<void>
  setState(taskId: string, state: PortTaskState): Promise<void>
  setTransientState(taskId: string, text: string | null): Promise<void>
  setStatus(taskId: string, status: PortTaskStatus): Promise<void>
  /** Every task (streams included) of a membrane. */
  listByMembrane(membrane: string): Promise<PortTask[]>
  streamsOf(membrane: string): Promise<WorkStream[]>
  createStream(membrane: string, name: string, parentId?: string): Promise<WorkStream>
  addToStream(streamId: string, taskId: string): Promise<void>
  removeFromStream(streamId: string, taskId: string): Promise<void>
  getViews(membrane: string): Promise<ForgeView[]>
  putViews(membrane: string, views: ForgeView[]): Promise<ForgeView[]>
  listRelated(membrane: string): Promise<RelatedEdgeRecord[]>
  addRelated(membrane: string, edge: Omit<RelatedEdgeRecord, 'createdAt' | 'accepted'>): Promise<RelatedEdgeRecord>
  /** false when no such edge exists. */
  acceptRelated(membrane: string, from: string, to: string, kind: WorkEdgeKind): Promise<boolean>
  deleteRelated(membrane: string, from: string, to: string, kind: WorkEdgeKind): Promise<boolean>
}

// ── Repo cache ─────────────────────────────────────────────────────────

/** A change as cached: the body is dropped once its "Paired with" refs are read. */
export interface CachedChange extends Change {
  paired: ForgeRef[]
  /** Branch compare against the base, keyed by head + base sha. */
  compare?: { ahead: number; behind: number; key: string }
  /** Total comments at the last read (owned changes only). */
  commentCount?: number
  /** Head sha the failed-check names were read for. */
  failedFor?: string
}

export type CachedIssue = Omit<ForgeIssue, 'body'> & { body: string; commentCount?: number }

export interface BackfillState {
  /** Cursor of the next page; absent before the first page. */
  cursor?: string
  done: boolean
  pages: number
  items: number
}

export interface RepoCache {
  version: 1
  forge: 'github' | 'radicle' | 'gitlab' | 'gitea' | 'local'
  host: string
  repo: string
  changes: Record<string, CachedChange>
  issues: Record<string, CachedIssue>
  /** Branch name → head sha (the last branch list). */
  branches: Record<string, string>
  /** ISO time the 21-day window sync finished. */
  windowSyncedAt?: string
  /** Start of the served window when the backfill began: it reads only items older than this. */
  backfillUntil?: string
  backfill: { changes: BackfillState; issues: BackfillState }
  lastOpenSyncAt?: string
  lastAllSyncAt?: string
  branchesSyncedAt?: string
  /** Node ids already reported stale. */
  stale: string[]
}

// ── Events, triage, digest ─────────────────────────────────────────────

export const FORGE_EVENT_TYPES = [
  'opened',
  'merged',
  'closed',
  'reopened',
  'pushed',
  'ci_failed',
  'ci_passed',
  'review_requested',
  'reviewed',
  'commented',
  'conflict',
  'behind_base',
  'base_merged',
  'labelled',
  'assigned',
  'referenced',
  'stale',
  'plan_changed'
] as const
export type ForgeEventType = (typeof FORGE_EVENT_TYPES)[number]

export interface ForgeEvent {
  at: string
  nodeId: string
  type: ForgeEventType
  detail: Record<string, unknown>
}

export type TriageVerdict = 'info' | 'needs-agent'
/** rule = a fixed rule decided; model = the classifier decided at ≥ threshold; model-low = below it; unavailable = no classifier answer. */
export type TriageTier = 'rule' | 'model' | 'model-low' | 'unavailable'

export interface TriagedEvent extends ForgeEvent {
  triage: TriageVerdict
  tier: TriageTier
  confidence?: number
}

export interface TriageCoverage {
  rule: { info: number; needsAgent: number }
  model: { info: number; needsAgent: number }
  modelLow: number
  unavailable: number
}

/** The decision model for events the rules cannot place. */
export interface ForgeClassifier {
  classify(input: {
    event: ForgeEvent
    node?: WorkNode
    owned: boolean
  }): Promise<{ choice: TriageVerdict; confidence: number } | undefined>
}

export interface DigestNode {
  node: WorkNode
  events: TriagedEvent[]
}

export interface DigestGroup {
  /** null = items in no stream. */
  stream: { id: string; name: string } | null
  nodes: DigestNode[]
}

export interface ForgeDigest {
  membrane: string
  since?: string
  /** Pass back as `since` for the next digest. */
  cursor?: string
  count: number
  groups: DigestGroup[]
}

// ── Overlay sources ────────────────────────────────────────────────────

export interface ThreadPresence {
  label: string
  status: 'working' | 'thinking' | 'idle'
  /** The thread is idle on a question to the user. */
  openQuestion?: boolean
}

export interface ActiveSubagent {
  key: string
  label: string
  parentThreadId: string
  cwd?: string
  startedAt: number
}

export interface ActiveCiWatch {
  threadKey: string
  repo: string
  target: { kind: 'pr'; number: number } | { kind: 'branch'; name: string } | { kind: 'sha'; sha: string }
  createdAt: number
}
