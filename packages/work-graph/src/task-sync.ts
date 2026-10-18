// Task sync — after each Loop 1 sync (and each tracked-item read), tasks
// attached to forge nodes get the provider status, a state that follows the
// work (forward only) and a one-line transientState. The notifier tells owner
// threads about CI red and green again, changes requested, approved, merged,
// closed unmerged, new comments, closed issues and conflicts.

import type { WorkEdge, WorkNode } from '@sovereign/core'
import type {
  CachedChange,
  CachedIssue,
  ForgeEvent,
  PortTask,
  PortTaskState,
  PortTaskStatus,
  TaskPort
} from './types.js'

export const TERMINAL: PortTaskState[] = ['completed', 'cancelled']

export interface StateContext {
  owned: boolean
  /** This sync saw the item reopen. */
  reopened: boolean
  /** An open change closes or references this issue. */
  changeOpen: boolean
  /** Close reason of a closed issue. */
  issueReason?: 'completed' | 'not_planned'
}

/** The state the task should move to, or undefined to leave it. */
export function nextTaskState(current: PortTaskState, node: WorkNode, ctx: StateContext): PortTaskState | undefined {
  const move = (to: PortTaskState) => (to === current ? undefined : to)
  const terminal = TERMINAL.includes(current)
  switch (node.kind) {
    case 'change':
      if (node.state === 'merged') return current === 'completed' ? undefined : move('completed')
      if (node.state === 'closed') return terminal ? undefined : move('cancelled')
      if (terminal) return ctx.reopened ? 'in_progress' : undefined
      return current === 'pending' ? 'in_progress' : undefined
    case 'issue':
      if (node.state === 'closed') {
        if (terminal) return undefined
        return ctx.issueReason === 'not_planned' ? 'cancelled' : 'completed'
      }
      if (terminal) return ctx.reopened ? 'in_progress' : undefined
      return current === 'pending' && (ctx.owned || ctx.changeOpen) ? 'in_progress' : undefined
    case 'plan':
      if (node.state === 'done') return terminal ? undefined : 'completed'
      if (current === 'pending' && (ctx.owned || node.state === 'in_progress')) return 'in_progress'
      return undefined
    default:
      return undefined
  }
}

const names = (xs: string[]) => xs.join(', ')

/** The live one-line status ("CI red: build · behind dev by 4"). */
export function statusLine(
  node: WorkNode,
  extra: { failed?: string[]; issueReason?: 'completed' | 'not_planned'; openChange?: WorkNode } = {}
): string | null {
  if (node.kind === 'change') {
    const base = node.branch?.base ?? 'base'
    if (node.state === 'merged') return `merged into ${base}`
    if (node.state === 'closed') return 'closed unmerged'
    const parts: string[] = []
    if (node.state === 'draft') parts.push('draft')
    if (node.ci === 'failing') {
      const f = extra.failed ?? []
      parts.push(f.length ? `CI red: ${f[0]}${f.length > 1 ? ` +${f.length - 1}` : ''}` : 'CI red')
    } else if (node.ci === 'pending') parts.push('CI running')
    if (node.branch?.conflict) parts.push(`conflict with ${base}`)
    if (node.branch?.behind) parts.push(`behind ${base} by ${node.branch.behind}`)
    const changes = node.reviewers.filter((r) => r.state === 'changes_requested').map((r) => r.login)
    const approved = node.reviewers.filter((r) => r.state === 'approved').map((r) => r.login)
    const requested = node.reviewers.filter((r) => r.state === 'requested').map((r) => r.login)
    if (changes.length) parts.push(`changes requested by ${names(changes)}`)
    else if (approved.length) parts.push(`approved by ${names(approved)}`)
    else if (requested.length) parts.push(`review requested from ${names(requested)}`)
    if (!parts.length && node.ci === 'passing') parts.push('CI green')
    return parts.length ? parts.join(' · ') : 'open'
  }
  if (node.kind === 'issue') {
    if (node.state === 'closed')
      return extra.issueReason === 'not_planned' ? 'closed as not planned' : 'closed as completed'
    if (extra.openChange)
      return `change #${extra.openChange.number} ${extra.openChange.state === 'draft' ? 'in draft' : 'open'}`
    if (node.assignees.length) return `assigned to ${names(node.assignees)}`
    return null
  }
  if (node.kind === 'plan')
    return node.state === 'done' ? 'plan done' : node.state === 'in_progress' ? 'plan in progress' : null
  return null
}

export function providerStatus(
  node: WorkNode,
  item: CachedChange | CachedIssue | undefined,
  at: string
): PortTaskStatus | undefined {
  if (node.kind === 'change') {
    const c = item as CachedChange | undefined
    const review = node.reviewers.some((r) => r.state === 'changes_requested')
      ? 'changes_requested'
      : node.reviewers.some((r) => r.state === 'approved')
        ? 'approved'
        : node.reviewers.some((r) => r.state === 'requested')
          ? 'review_required'
          : 'none'
    return {
      kind: 'change',
      state: node.state,
      checks: node.ci ?? 'none',
      ...(c?.checks?.failed?.length ? { failedChecks: c.checks.failed } : {}),
      review,
      ...(c?.commentCount !== undefined ? { unresolvedComments: c.commentCount } : {}),
      lastPolledAt: at
    }
  }
  if (node.kind === 'issue') {
    const i = item as CachedIssue | undefined
    return {
      kind: 'issue',
      state: node.state === 'closed' ? `closed:${i?.closedReason ?? 'completed'}` : 'open',
      ...(i?.commentCount !== undefined ? { unresolvedComments: i.commentCount } : {}),
      lastPolledAt: at
    }
  }
  if (node.kind === 'plan') return { kind: 'plan', state: node.state, lastPolledAt: at }
  return undefined
}

/**
 * Same status apart from the poll time. A comment count the new status did
 * not read keeps the stored one; no failed checks equals an empty list.
 */
export function sameStatus(a: PortTaskStatus | undefined, b: PortTaskStatus): boolean {
  if (!a) return false
  const norm = (s: PortTaskStatus, comments: number | undefined) =>
    JSON.stringify([s.kind, s.state, s.checks ?? null, s.failedChecks ?? [], s.review ?? null, comments ?? null])
  return (
    norm(a, b.unresolvedComments === undefined ? undefined : a.unresolvedComments) === norm(b, b.unresolvedComments)
  )
}

/** The owner thread's notification for a Loop 1 event, if any. */
export function notificationFor(e: ForgeEvent, node: WorkNode): string | undefined {
  const isChange = node.kind === 'change'
  const tag = `[${isChange ? 'PR' : 'Issue'} #${node.number}]`
  const repo = node.repo ?? ''
  const view = isChange
    ? `gh pr view ${node.number} -R ${repo} --comments`
    : `gh issue view ${node.number} -R ${repo} --comments`
  const d = e.detail as Record<string, any>
  switch (e.type) {
    case 'ci_failed': {
      const failed: string[] = Array.isArray(d.failed) ? d.failed : []
      return `${tag} CI check failed${failed.length ? `: ${failed.join(', ')}` : ''}. Run \`gh pr checks ${node.number} -R ${repo}\` for details.`
    }
    case 'ci_passed':
      return d.from === 'failing' ? `${tag} CI checks now passing.` : undefined
    case 'reviewed':
      if (d.state === 'changes_requested')
        return `${tag} Changes requested by ${d.login}. Run \`${view}\` to see review comments.`
      if (d.state === 'approved') return `${tag} Approved by ${d.login}.`
      return undefined
    case 'merged':
      return `${tag} Merged.`
    case 'closed':
      return isChange
        ? `${tag} Closed without merge.`
        : `${tag} Closed (${d.reason === 'not_planned' ? 'not planned' : 'completed'}).`
    case 'commented': {
      const n = Number(d.count ?? 1)
      return `${tag} ${n} new comment${n > 1 ? 's' : ''}. Run \`${view}\` to review.`
    }
    case 'conflict':
      return `${tag} Conflicts with ${d.base}. Merge the base in and resolve.`
    default:
      return undefined
  }
}

export interface TaskSyncInput {
  tasks: PortTask[]
  nodes: Map<string, WorkNode>
  edges: WorkEdge[]
  events: ForgeEvent[]
  item(nodeId: string): CachedChange | CachedIssue | undefined
  now: string
}

export interface TaskSyncResult {
  updated: number
  notifications: Array<{ threadId: string; text: string; nodeId: string }>
}

/** Write status, state and transientState onto every task attached to a node. */
export async function syncTasks(port: TaskPort, input: TaskSyncInput): Promise<TaskSyncResult> {
  const reopened = new Set(input.events.filter((e) => e.type === 'reopened').map((e) => e.nodeId))
  // Issue → the open change that closes or names it.
  const openChangeFor = new Map<string, WorkNode>()
  for (const e of input.edges) {
    if (e.kind !== 'closes' && e.kind !== 'references') continue
    const from = input.nodes.get(e.from)
    const to = input.nodes.get(e.to)
    if (from?.kind === 'change' && (from.state === 'open' || from.state === 'draft') && to?.kind === 'issue') {
      if (!openChangeFor.has(to.id) || e.kind === 'closes') openChangeFor.set(to.id, from)
    }
  }
  const result: TaskSyncResult = { updated: 0, notifications: [] }
  for (const t of input.tasks) {
    if (!t.key) continue
    const node = input.nodes.get(t.key)
    if (!node) continue
    const item = input.item(node.id)
    const issueReason = node.kind === 'issue' ? (item as CachedIssue | undefined)?.closedReason : undefined
    let touched = false

    const status = providerStatus(node, item, input.now)
    if (status && !sameStatus(t.status, status)) {
      await port.setStatus(t.id, status)
      touched = true
    }
    // A work stream's state is its epic status, which the user sets.
    const next = t.isStream
      ? undefined
      : nextTaskState(t.state, node, {
          owned: Boolean(t.threadId),
          reopened: reopened.has(node.id),
          changeOpen: openChangeFor.has(node.id),
          ...(issueReason ? { issueReason } : {})
        })
    if (next) {
      await port.setState(t.id, next)
      touched = true
    }
    const line = statusLine(node, {
      failed: (item as CachedChange | undefined)?.checks?.failed,
      ...(issueReason ? { issueReason } : {}),
      ...(openChangeFor.get(node.id) ? { openChange: openChangeFor.get(node.id) } : {})
    })
    if ((line ?? null) !== (t.transientState ?? null)) {
      await port.setTransientState(t.id, line)
      touched = true
    }
    if (touched) result.updated++
    if (t.threadId) {
      for (const e of input.events) {
        if (e.nodeId !== node.id) continue
        const text = notificationFor(e, node)
        if (text) result.notifications.push({ threadId: t.threadId, text, nodeId: node.id })
      }
    }
  }
  return result
}
