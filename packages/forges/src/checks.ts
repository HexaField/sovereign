// GitHub checks — check runs (Actions, Apps) and commit statuses (CircleCI
// and other status-only CI) folded into one state per check name. CI watch
// and the forge adapter's checks() share this fold, so both agree on what
// "failed" means.

import type { CheckSummary } from '@sovereign/core'

export interface CheckState {
  name: string
  state: 'pending' | 'success' | 'failure' | 'neutral'
  conclusion?: string
  url?: string
  summary?: string
}

/** Check-run conclusions and status states that count as a failure. */
export const FAILED_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
  'error'
])

const RANK: Record<CheckState['state'], number> = { failure: 3, pending: 2, neutral: 1, success: 0 }

/** Fold check runs and commit statuses into one state per check name. When
 *  two sources post the same name, the worse state wins. */
export function toCheckStates(checkRuns: any[], statuses: any[]): CheckState[] {
  const out = new Map<string, CheckState>()
  const keep = (c: CheckState) => {
    const prev = out.get(c.name)
    if (!prev || RANK[c.state] > RANK[prev.state]) out.set(c.name, c)
  }
  for (const r of checkRuns) {
    const conclusion = r.status === 'completed' ? (r.conclusion ?? 'neutral') : undefined
    keep({
      name: r.name,
      state: !conclusion
        ? 'pending'
        : conclusion === 'success'
          ? 'success'
          : FAILED_CONCLUSIONS.has(conclusion)
            ? 'failure'
            : 'neutral',
      conclusion: conclusion ?? r.status,
      url: r.html_url ?? r.details_url,
      summary: r.output?.title ?? undefined
    })
  }
  for (const s of statuses) {
    keep({
      name: s.context,
      state: s.state === 'pending' ? 'pending' : s.state === 'success' ? 'success' : 'failure',
      conclusion: s.state,
      url: s.target_url ?? undefined,
      summary: s.description ?? undefined
    })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** One summary for a commit: any failure → failing (with names), else any pending → pending. */
export function summarizeChecks(checks: CheckState[]): CheckSummary {
  if (!checks.length) return { state: 'none' }
  const failed = checks.filter((c) => c.state === 'failure').map((c) => c.name)
  if (failed.length) return { state: 'failing', failed }
  if (checks.some((c) => c.state === 'pending')) return { state: 'pending' }
  return { state: 'passing' }
}

/** GraphQL `statusCheckRollup.state` → ChecksState. */
export function rollupToChecks(rollup: { state?: string } | null | undefined): CheckSummary {
  switch (rollup?.state) {
    case 'SUCCESS':
      return { state: 'passing' }
    case 'FAILURE':
    case 'ERROR':
      return { state: 'failing' }
    case 'PENDING':
    case 'EXPECTED':
      return { state: 'pending' }
    default:
      return { state: 'none' }
  }
}
