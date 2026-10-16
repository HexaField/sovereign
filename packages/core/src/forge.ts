// Forge — shared contract between the forge adapters (server), the work graph
// (server) and the Forge tab (client). Types plus two pure helpers, so the
// client can import it without pulling server modules.

/** Where an item lives. 'local' = plans and tasks that live in Sovereign only. */
export type ForgeKind = 'github' | 'radicle' | 'gitlab' | 'gitea' | 'local'

/** One item on one forge. */
export interface ForgeRef {
  forge: ForgeKind
  /** "github.com", or a self-hosted host. */
  host: string
  /** "owner/name" (GitHub, GitLab, Gitea) or a Radicle RID. */
  repo: string
  kind: 'change' | 'issue' | 'branch'
  /** Number as a string on GitHub/GitLab/Gitea; hash on Radicle; branch name for branches. */
  id: string
}

export type ChangeState = 'open' | 'draft' | 'merged' | 'closed'
export type ChecksState = 'passing' | 'failing' | 'pending' | 'none'
export type ReviewState = 'requested' | 'approved' | 'changes_requested' | 'commented' | 'dismissed'

export interface Review {
  login: string
  state: ReviewState
}

export interface CheckSummary {
  state: ChecksState
  /** Names of failed checks, when the forge reports them. */
  failed?: string[]
}

/** A pull request, merge request or patch. */
export interface Change {
  ref: ForgeRef
  title: string
  body: string
  state: ChangeState
  author: string
  assignees: string[]
  reviewers: Review[]
  labels: string[]
  head: { branch?: string; sha: string }
  base: { branch: string }
  /** false = conflicts with the base; undefined = unknown. */
  mergeable?: boolean
  closes: ForgeRef[]
  references: ForgeRef[]
  checks?: CheckSummary
  createdAt: string
  updatedAt: string
  closedAt?: string
  url: string
  /** Forge-specific fields, shown on the card as they are. */
  extra?: Record<string, unknown>
}

export interface ForgeIssue {
  ref: ForgeRef
  title: string
  body: string
  state: 'open' | 'closed'
  closedReason?: 'completed' | 'not_planned'
  author: string
  assignees: string[]
  labels: string[]
  references: ForgeRef[]
  createdAt: string
  updatedAt: string
  closedAt?: string
  url: string
}

export interface ForgeBranch {
  name: string
  sha: string
}

export interface ForgeComment {
  author: string
  body: string
  createdAt: string
  url?: string
}

export interface ForgeCapabilities {
  reviews: boolean
  checks: boolean
  labels: boolean
  assignees: boolean
  crossRefs: boolean
}

export interface ListOpts {
  /** Only items updated at or after this ISO time. */
  since?: string
  /** Only items updated before this ISO time. */
  until?: string
  state?: 'open' | 'all'
}

/** One page of a newest-updated-first list, resumable from `cursor`. */
export interface ForgePage<T> {
  items: T[]
  /** Pass as `after` to read the next page; absent when there is none. */
  cursor?: string
  hasNext: boolean
}

export interface PageOpts {
  /** Cursor of the previous page. */
  after?: string
  /** Skip items updated at or after this ISO time. */
  until?: string
}

/** One forge adapter. Today only GitHub implements it. */
export interface Forge {
  kind: ForgeKind
  host: string
  capabilities: ForgeCapabilities
  listChanges(repo: string, opts?: ListOpts): Promise<Change[]>
  listIssues(repo: string, opts?: ListOpts): Promise<ForgeIssue[]>
  listBranches(repo: string): Promise<ForgeBranch[]>
  /** One page of changes (all states), for a resumable backfill. Optional: without it a backfill is one listChanges call. */
  pageChanges?(repo: string, opts?: PageOpts): Promise<ForgePage<Change>>
  /** One page of issues (all states), for a resumable backfill. */
  pageIssues?(repo: string, opts?: PageOpts): Promise<ForgePage<ForgeIssue>>
  /** Ahead/behind of a branch against the repo's default branch. */
  compare(repo: string, base: string, head: string): Promise<{ ahead: number; behind: number }>
  checks(ref: ForgeRef): Promise<CheckSummary | undefined>
  comments(ref: ForgeRef): Promise<ForgeComment[]>
  /** The one write the Forge tab makes (assign ↔ forge assignee). */
  setAssignees(ref: ForgeRef, add: string[], remove: string[]): Promise<void>
  /** The login this adapter acts as. */
  identity(): Promise<string>
}

// ── Work graph ─────────────────────────────────────────────────────────

export type WorkNodeKind = 'change' | 'issue' | 'branch' | 'plan' | 'task'
export type Zone = 'past' | 'present' | 'future'
export type WorkNodeState = ChangeState | 'planned' | 'done' | 'in_progress' | 'cancelled'

export interface WorkNode {
  /** refKey(ref) for forge items; "plan:<project>/<path>"; "task:<taskId>". */
  id: string
  forge: ForgeKind
  kind: WorkNodeKind
  repo?: string
  number?: number
  title: string
  url?: string
  state: WorkNodeState
  zone: Zone
  author?: string
  assignees: string[]
  reviewers: Review[]
  labels: string[]
  /** Task ids of the work streams the node belongs to. */
  workstreams: string[]
  taskId?: string
  branch?: { head: string; base: string; ahead?: number; behind?: number; conflict?: boolean }
  ci?: ChecksState
  /** The live one-line status (task transientState). */
  status?: string
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export type WorkEdgeKind = 'base' | 'merged-into' | 'closes' | 'references' | 'paired' | 'plans' | 'subtask' | 'related'

export interface WorkEdge {
  from: string
  to: string
  kind: WorkEdgeKind
  /** Future-facing: references, plans, related, closes on an open issue. */
  dashed: boolean
  source: 'sync' | 'rethink' | 'josh'
  reason?: string
  confidence?: number
}

export interface AgentOverlay {
  nodeId: string
  thread?: { id: string; label: string; status: 'working' | 'thinking' | 'idle' }
  subagents: { key: string; label: string; startedAt: number }[]
  ciWatch?: { state: 'waiting' | 'passed' | 'failed'; since: number }
  waitingOn?: 'ci' | 'review' | 'josh' | null
}

export interface WorkStream {
  /** The stream's task id. */
  id: string
  name: string
  membrane: string
  parentId?: string
  memberCount: number
}

export interface ForgeView {
  id: string
  membrane: string
  title: string
  /** "owner/name" repos; empty = every repo of the membrane. */
  repos: string[]
  filters: ForgeFilters
  height?: number
}

export interface ForgeFilters {
  repos?: string[]
  states?: WorkNodeState[]
  zones?: Zone[]
  authors?: string[]
  assignees?: string[]
  reviewers?: string[]
  requestedFromMe?: boolean
  labels?: string[]
  workstreams?: string[]
  agent?: 'any' | 'waiting-ci' | 'waiting-review'
  updatedWithinDays?: number
  text?: string
  /** Dim non-matching nodes instead of hiding them. */
  dim?: boolean
}

/** GET /api/forge response. */
export interface ForgeGraph {
  membrane: string
  /** The window served: [since, until). */
  since: string
  until: string
  nodes: WorkNode[]
  edges: WorkEdge[]
  workstreams: WorkStream[]
  /** True while the first backfill still runs. */
  syncing: boolean
  lastSyncAt?: string
}

/** String form of a ForgeRef: "github:github.com/coasys/ad4m#1390", branches "…@feat/x". */
export function refKey(ref: ForgeRef): string {
  const sep = ref.kind === 'branch' ? '@' : '#'
  return `${ref.forge}:${ref.host}/${ref.repo}${sep}${ref.id}`
}

/** Inverse of refKey for change/issue keys; the kind cannot be told from the key, so it is passed in. */
export function parseRefKey(key: string, kind: ForgeRef['kind']): ForgeRef | undefined {
  const m = /^(github|radicle|gitlab|gitea|local):([^/]+)\/([^#@]+)([#@])(.+)$/.exec(key)
  if (!m) return undefined
  return { forge: m[1] as ForgeKind, host: m[2], repo: m[3], kind, id: m[5] }
}
