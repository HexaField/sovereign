// Holonic task ontology — type definitions.
//
// Tasks form a DAG (directed acyclic graph). Each task functions as both
// whole and part — many-to-many parent/child relationships. A work stream is
// a task flagged `isStream`; its members are its child tasks. Persisted in the
// `sovereign-forge` AD4M perspective (see ontology.ts).

import type { ChangeState, ForgeRef } from '@sovereign/core'
import { refKey } from '@sovereign/core'

/** `paused`: set aside, neither in flight nor done (an epic's "paused" status). */
export type TaskState = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'

export const TASK_STATES: readonly TaskState[] = ['pending', 'in_progress', 'paused', 'completed', 'cancelled'] as const

// ── Providers ─────────────────────────────────────────────────────────

export type ChecksStatus = 'pending' | 'passing' | 'failing' | 'unknown'
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'unknown'

/** A pull request (merge request, patch) on a forge. */
export interface ChangeProvider {
  kind: 'change'
  /** refs[0] is the primary ref; later refs are the same change on other forges. */
  refs: ForgeRef[]
  url: string
  status: ChangeState
  checksStatus: ChecksStatus
  reviewDecision: ReviewDecision
  unresolvedComments: number
  /** Names of the failed checks, when CI is failing. */
  failedChecks?: string[]
  /** ISO timestamp of the last poll. */
  lastPolledAt: string
}

/** An issue on a forge. */
export interface IssueProvider {
  kind: 'issue'
  refs: ForgeRef[]
  url: string
  issueState: 'open' | 'closed'
  closedReason?: 'completed' | 'not_planned'
  /** Comment count at the last poll, when read. */
  unresolvedComments?: number
  lastPolledAt: string
}

/** A plan file in a project (or a membrane's plans directory). */
export interface PlanProvider {
  kind: 'plan'
  project: string
  /** Path of the plan file, relative to the project. */
  path: string
  status: 'planned' | 'in_progress' | 'done'
}

/** What a task stands for outside Sovereign. Absent for task-only work. */
export type TaskProvider = ChangeProvider | IssueProvider | PlanProvider
export type ProviderKind = TaskProvider['kind']
export const PROVIDER_KINDS: readonly ProviderKind[] = ['change', 'issue', 'plan'] as const

/** The pre-Forge provider shape. Converted to a `change` provider on load. */
export interface LegacyGithubPrProvider {
  kind: 'github-pr'
  url: string
  repo: string
  number: number
  prStatus: ChangeState
  checksStatus: ChecksStatus
  reviewDecision: ReviewDecision
  lastPolledAt: string
  unresolvedComments: number
}

/** The idempotency key of a provider: refKey(refs[0]) for forge items,
 *  "plan:<project>/<path>" for plans. */
export function providerKey(p: TaskProvider): string {
  if (p.kind === 'plan') return planKey(p.project, p.path)
  return refKey(p.refs[0])
}

export function planKey(project: string, planPath: string): string {
  return `plan:${project}/${planPath.replace(/^\/+/, '')}`
}

/** Inverse of planKey: "plan:<project>/<path>" → { project, path }. The project is the first segment. */
export function parsePlanKey(key: string): { project: string; path: string } | undefined {
  const m = /^plan:([^/]+)\/(.+)$/.exec(key)
  return m ? { project: m[1], path: m[2] } : undefined
}

/** "owner/name" repos a provider touches (empty for plans). */
export function providerRepos(p: TaskProvider): string[] {
  if (p.kind === 'plan') return []
  return [...new Set(p.refs.map((r) => r.repo))]
}

function githubRef(repo: string, kind: ForgeRef['kind'], id: string | number): ForgeRef {
  return { forge: 'github', host: 'github.com', repo, kind, id: String(id) }
}

function isRef(v: unknown): v is ForgeRef {
  const r = v as ForgeRef
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.forge === 'string' &&
    typeof r.host === 'string' &&
    typeof r.repo === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.id === 'string'
  )
}

/** Accept any stored or incoming provider shape and return the current one.
 *  Legacy `github-pr` providers become `change` providers; anything that is
 *  not a recognisable provider returns undefined. */
export function normalizeProvider(raw: unknown): TaskProvider | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, any>
  switch (p.kind) {
    case 'github-pr': {
      if (typeof p.repo !== 'string' || p.number === undefined) return undefined
      return {
        kind: 'change',
        refs: [githubRef(p.repo, 'change', p.number)],
        url: typeof p.url === 'string' ? p.url : `https://github.com/${p.repo}/pull/${p.number}`,
        status: p.prStatus ?? 'open',
        checksStatus: p.checksStatus ?? 'unknown',
        reviewDecision: p.reviewDecision ?? 'unknown',
        unresolvedComments: Number(p.unresolvedComments ?? 0),
        lastPolledAt: p.lastPolledAt ?? new Date(0).toISOString()
      }
    }
    case 'change': {
      const refs = Array.isArray(p.refs) ? p.refs.filter(isRef) : []
      if (refs.length === 0) return undefined
      return {
        kind: 'change',
        refs,
        url: String(p.url ?? ''),
        status: p.status ?? 'open',
        checksStatus: p.checksStatus ?? 'unknown',
        reviewDecision: p.reviewDecision ?? 'unknown',
        unresolvedComments: Number(p.unresolvedComments ?? 0),
        ...(Array.isArray(p.failedChecks) ? { failedChecks: p.failedChecks.map(String) } : {}),
        lastPolledAt: p.lastPolledAt ?? new Date(0).toISOString()
      }
    }
    case 'issue': {
      const refs = Array.isArray(p.refs) ? p.refs.filter(isRef) : []
      if (refs.length === 0) return undefined
      return {
        kind: 'issue',
        refs,
        url: String(p.url ?? ''),
        issueState: p.issueState === 'closed' ? 'closed' : 'open',
        ...(p.closedReason === 'completed' || p.closedReason === 'not_planned' ? { closedReason: p.closedReason } : {}),
        ...(p.unresolvedComments !== undefined ? { unresolvedComments: Number(p.unresolvedComments) } : {}),
        lastPolledAt: p.lastPolledAt ?? new Date(0).toISOString()
      }
    }
    case 'plan': {
      if (typeof p.project !== 'string' || typeof p.path !== 'string') return undefined
      const status = p.status === 'done' || p.status === 'in_progress' ? p.status : 'planned'
      return { kind: 'plan', project: p.project, path: p.path, status }
    }
    default:
      return undefined
  }
}

// ── Tasks ─────────────────────────────────────────────────────────────

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
  /** Membrane id the task belongs to; null = none recorded. */
  membrane: string | null
  /** True when the task is a work stream (its children are its members). */
  isStream: boolean
  /** External item the task stands for. */
  provider?: TaskProvider
}

/** The stored scalar part of a task (no resolved relationships). */
export type TaskRecord = Omit<Task, 'parentTasks' | 'childTasks'>

/** Fields a store update may change. */
export type TaskFields = Partial<
  Pick<
    Task,
    | 'name'
    | 'state'
    | 'threadId'
    | 'description'
    | 'transientState'
    | 'updatedAt'
    | 'tags'
    | 'provider'
    | 'membrane'
    | 'isStream'
  >
>

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
  membrane: string | null
  isStream: boolean
  childCount: number
  parentCount: number
  provider?: TaskProvider
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
  | 'task.provider_updated'

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
  /** External provider metadata. Legacy shapes are converted. */
  provider?: TaskProvider | LegacyGithubPrProvider
  membrane?: string | null
  /** Create the task as a work stream. */
  isStream?: boolean
  /** Initial state. Defaults to pending. */
  state?: TaskState
}

export interface UpdateTaskOpts {
  state?: TaskState
  /** null clears it. */
  transientState?: string | null
  name?: string
  description?: string
  /** Pass string to reassign, null to unassign, undefined to leave unchanged. */
  threadId?: string | null
  /** Replaces the entire tag set when provided. */
  tags?: string[]
  /** Thread UUID of the caller (injected by the MCP layer). */
  sourceThreadId: string
  /** Update provider metadata. Legacy shapes are converted. */
  provider?: TaskProvider | LegacyGithubPrProvider
  membrane?: string | null
  isStream?: boolean
}

export interface ListTaskFilter {
  state?: TaskState
  threadId?: string | null
  parentId?: string
  rootsOnly?: boolean
  membrane?: string
  /** "owner/name": tasks whose provider refs name this repo (case-insensitive). */
  repo?: string
  /** A stream's task id: every task below it, through nested streams. */
  workstream?: string
  /** Provider kind; 'none' = tasks without a provider. */
  providerKind?: ProviderKind | 'none'
  /** Only streams (true) or only non-streams (false). */
  isStream?: boolean
}

export interface SubscribeFilter {
  taskId?: string
  threadId?: string
  state?: TaskState
}
