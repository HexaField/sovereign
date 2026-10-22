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
  /** One change, read alone (tracked items outside every synced repo); undefined when it does not exist. */
  getChange?(ref: ForgeRef): Promise<Change | undefined>
  /** One issue, read alone; undefined when it does not exist. */
  getIssue?(ref: ForgeRef): Promise<ForgeIssue | undefined>
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
export type WorkNodeState = ChangeState | 'planned' | 'done' | 'in_progress' | 'paused' | 'cancelled'

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
  /** Task ids of the work streams that own the node: at most one for a change or issue. */
  workstreams: string[]
  /** Streams the node is related to but not owned by: the epics of plans that name it. */
  relatedStreams?: string[]
  taskId?: string
  /** Its task is paused: the user set it aside. Hidden unless `filters.showPaused`. */
  paused?: boolean
  branch?: { head: string; base: string; ahead?: number; behind?: number; conflict?: boolean }
  ci?: ChecksState
  /** The live one-line status (task transientState). */
  status?: string
  /** What Loop 2 (rethink) did or said about this node, oldest first. */
  rethink?: RethinkNote[]
  /** An open change's code structure (Graphcoder), when the host wires it in and the repo has a local checkout. */
  structure?: WorkNodeStructure
  createdAt: string
  updatedAt: string
  closedAt?: string
  /** A closed issue: completed, or closed as not planned (cancelled). */
  closedReason?: 'completed' | 'not_planned'
}

/**
 * The structure of a change as its node carries it: state and the numbers a card shows. The full structure
 * (symbols, modules, tests) comes from Graphcoder's `GET /api/graphcoder/structure/cached?path=&base=&head=`.
 */
export interface WorkNodeStructure {
  state: 'computing' | 'ready' | 'failed'
  /** Local checkout the structure is computed in */
  path: string
  /** Computing: the base ref asked for (`origin/dev`); ready: the merge-base sha */
  base: string
  /** Head sha */
  head: string
  /** Ready: how far the change spreads (diameter of its changed symbols) and in how many separate parts */
  reach?: number
  parts?: number
  /** Ready: modules touched, symbols added + removed + modified, tests that reach the change */
  modules?: number
  symbols?: number
  tests?: number
  /** Ready, when the repo has a concept tree and the change touches it: one line of shifted and touched concepts */
  concepts?: string
  /** Failed: why */
  error?: string
}

/** A rethink action shown on a node's card. */
export interface RethinkNote {
  at: string
  /** note = forge_note; dispatch = a job sent to a thread; draft = a bug-report draft; attention = told the user. */
  kind: 'note' | 'dispatch' | 'draft' | 'attention'
  text: string
  /** The run report it belongs to. */
  runId?: string
}

export type WorkEdgeKind = 'base' | 'merged-into' | 'closes' | 'references' | 'paired' | 'plans' | 'subtask' | 'related'

/** Who made an edge: Loop 1 sync, Loop 2 rethink, or the user (by hand, or accepting a rethink edge). */
export type WorkEdgeSource = 'sync' | 'rethink' | 'user'

export interface WorkEdge {
  from: string
  to: string
  kind: WorkEdgeKind
  /** Future-facing: references, plans, related, closes on an open issue. */
  dashed: boolean
  source: WorkEdgeSource
  reason?: string
  confidence?: number
}

export interface AgentOverlay {
  nodeId: string
  thread?: { id: string; label: string; status: 'working' | 'thinking' | 'idle' }
  subagents: { key: string; label: string; startedAt: number }[]
  ciWatch?: { state: 'waiting' | 'passed' | 'failed'; since: number }
  /** user = the owner thread is idle on a question to the user. */
  waitingOn?: 'ci' | 'review' | 'user' | null
}

export interface WorkStream {
  /** The stream's task id. */
  id: string
  name: string
  membrane: string
  parentId?: string
  memberCount: number
  /** Graph nodes related to the stream (a plan of it names them) without being members; set by the work graph. */
  relatedCount?: number
  /** From its task's state (`epicStatusOf`); an archived stream is left out of the graph unless asked for. */
  status: EpicStatus
  /** The plan key ("plan:<project>/<path>") of a stream a plan file made; absent for a hand-made stream. */
  plan?: string
  /** Its leaves over its whole subtree (sub-streams included); set by the work graph's `graph()`. */
  progress?: StreamProgress
}

/**
 * A stream's leaves (member PRs, issues and task-only tasks) over its subtree.
 * `total` leaves cancelled ones out; `blocked` counts open leaves waiting on another open PR.
 */
export interface StreamProgress {
  done: number
  total: number
  blocked: number
}

/** A goal-tree leaf's state (plan §7.3): merged / closed completed → done, closed unmerged / not planned → cancelled. Plans and branches are no leaves (undefined). */
export function leafState(
  n: Pick<WorkNode, 'kind' | 'state' | 'closedReason'>
): 'done' | 'cancelled' | 'open' | undefined {
  switch (n.kind) {
    case 'change':
      return n.state === 'merged' ? 'done' : n.state === 'closed' ? 'cancelled' : 'open'
    case 'issue':
      return n.state === 'open' ? 'open' : n.closedReason === 'not_planned' ? 'cancelled' : 'done'
    case 'task':
      return n.state === 'done' ? 'done' : n.state === 'cancelled' ? 'cancelled' : 'open'
    default:
      return undefined
  }
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
  /** Node kinds to show: PRs (`change`), issues, plans, tasks, branches. */
  kinds?: WorkNodeKind[]
  states?: WorkNodeState[]
  zones?: Zone[]
  authors?: string[]
  assignees?: string[]
  reviewers?: string[]
  requestedFromMe?: boolean
  labels?: string[]
  /** Selected epics (work stream ids): the client focuses the canvas on their members. */
  workstreams?: string[]
  /**
   * Epic statuses the epics panel shows (empty = every status but archived). Statuses
   * chosen and no epic picked in `workstreams`: every epic with those statuses is selected.
   */
  epicStatus?: EpicStatus[]
  /** false = show only the selected epics' members, not their direct neighbours too (default on). */
  epicNeighbours?: boolean
  /** true = the selected epics' related items count too ("Owned + related"); default owned only. */
  epicRelated?: boolean
  /** "Not in a tree": only open PRs and issues no work stream owns (client-side, like the epic selection). */
  orphans?: boolean
  agent?: 'any' | 'waiting-ci' | 'waiting-review'
  updatedWithinDays?: number
  text?: string
  /** Show paused items and paused epics (with the streams and items below a paused epic); default hidden. */
  showPaused?: boolean
  /** Show plan epics that own no items (none in their subtree, no hand-made node below); default hidden. */
  showEmpty?: boolean
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
  /** GitHub sync is off (`forge.enabled` false): only plans and tracked tasks show. */
  syncOff?: boolean
  lastSyncAt?: string
  /** The membrane's forge login (the account Forge acts as); the client's "requested from me" filter matches it. */
  identity?: string
}

// ── Task port ──────────────────────────────────────────────────────────
// What the work graph needs from the task graph. @sovereign/tasks binds it
// (createForgeTaskPort); the work graph's tests use an in-memory one.

export type PortTaskState = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'

/** An epic's (work stream's) status: the user's call, stored as its task's state. */
export type EpicStatus = 'planned' | 'active' | 'paused' | 'archived'
export const EPIC_STATUSES: readonly EpicStatus[] = ['active', 'planned', 'paused', 'archived']

const EPIC_STATE: Record<EpicStatus, PortTaskState> = {
  planned: 'pending',
  active: 'in_progress',
  paused: 'paused',
  archived: 'cancelled'
}

/** pending → planned, in_progress → active, paused → paused, cancelled or completed → archived. */
export function epicStatusOf(state: PortTaskState): EpicStatus {
  if (state === 'completed') return 'archived'
  return (Object.keys(EPIC_STATE) as EpicStatus[]).find((s) => EPIC_STATE[s] === state) ?? 'planned'
}

/** The task state an epic status is stored as. */
export function stateOfEpicStatus(status: EpicStatus): PortTaskState {
  return EPIC_STATE[status]
}

export type PortTaskKind = 'change' | 'issue' | 'plan'

/** Last-known forge status written onto a task (the TaskProvider's status fields). */
export interface PortTaskStatus {
  kind: PortTaskKind
  /** Change state, issue state ("open" / "closed:completed" / "closed:not_planned") or plan state. */
  state: string
  checks?: ChecksState
  failedChecks?: string[]
  review?: 'approved' | 'changes_requested' | 'review_required' | 'none'
  /** Comment count at the last poll (issue + review comments); absent = not read. */
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
  /** Provider kind; absent for a task-only task. */
  kind?: PortTaskKind
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
  kind: PortTaskKind
  url?: string
  ref?: ForgeRef
  plan?: { project: string; path: string }
  /** Make the task a work stream (an existing task for the key becomes one). */
  stream?: boolean
}

export interface RelatedEdgeRecord {
  from: string
  to: string
  kind: WorkEdgeKind
  reason?: string
  confidence?: number
  source: WorkEdgeSource
  /** Accepted by the user: shown as source 'user'. */
  accepted: boolean
  createdAt: string
}

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
  /** Every task with a change or issue provider, any membrane or none. */
  listForgeItems(): Promise<PortTask[]>
  streamsOf(membrane: string): Promise<WorkStream[]>
  createStream(membrane: string, name: string, parentId?: string): Promise<WorkStream>
  setName(taskId: string, name: string): Promise<void>
  /** Make a task a work stream, or a plain task again (its links stay). */
  setStream(taskId: string, isStream: boolean): Promise<void>
  /** A change or issue task has one owning stream: adding it to one removes it from any other. */
  addToStream(streamId: string, taskId: string): Promise<void>
  removeFromStream(streamId: string, taskId: string): Promise<void>
  /** A membrane's saved views, in order. */
  getViews(membrane: string): Promise<ForgeView[]>
  /** Replace a membrane's views (the order is kept). */
  putViews(membrane: string, views: ForgeView[]): Promise<ForgeView[]>
  listRelated(membrane: string): Promise<RelatedEdgeRecord[]>
  /** An edge already there (same from, to, kind) is returned as it is. */
  addRelated(membrane: string, edge: Omit<RelatedEdgeRecord, 'createdAt' | 'accepted'>): Promise<RelatedEdgeRecord>
  /** false when no such edge exists. */
  acceptRelated(membrane: string, from: string, to: string, kind: WorkEdgeKind): Promise<boolean>
  deleteRelated(membrane: string, from: string, to: string, kind: WorkEdgeKind): Promise<boolean>
}

/** What a thread assigned to a node is asked to do, unless the user writes the prompt. */
export function defaultWorkPrompt(n: WorkNode): string {
  const target = n.url ?? (n.kind === 'plan' ? `the plan "${n.title}" (${n.id.replace(/^plan:/, '')})` : `"${n.title}"`)
  switch (n.kind) {
    case 'change':
      return `Work on ${target}: fetch the PR, its comments and CI, then address the review comments and failing checks, merge the base in if it is behind, and push.`
    case 'issue':
      return `Work on ${target}: fetch the issue, its comments and any linked PRs, then fix it on a branch and open a PR that closes it.`
    case 'branch':
      return `Work on the branch ${n.branch?.head ?? n.title}${n.repo ? ` in ${n.repo}` : ''}: fetch it, compare it with its base, then finish the work and open a PR.`
    case 'plan':
      return `Work on ${target}: read the plan and the PRs and issues it names, then take the next open step.`
    default:
      return `Work on the task ${target}: read its parent streams and linked items, then do it and report back.`
  }
}

/** The Loop 2 tools, registered only in a membrane's forge-rethink thread. */
export const FORGE_TOOLS = [
  'forge_relate',
  'forge_stream_add',
  'forge_dispatch',
  'forge_bug_draft',
  'forge_attention',
  'forge_note',
  'forge_stream_create',
  'forge_stream_rename',
  'forge_stream_status',
  'forge_stream_remove',
  'forge_stream_merge',
  'forge_stream_parent'
] as const
export type ForgeToolName = (typeof FORGE_TOOLS)[number]

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
