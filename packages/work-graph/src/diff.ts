// What changed between two reads of one item → Loop 1 events. Pure.

import { refKey } from '@sovereign/core'
import type { CachedChange, CachedIssue, ForgeEventType } from './types.js'

export interface ItemEvent {
  type: ForgeEventType
  detail: Record<string, unknown>
}

const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x))

export function diffChange(prev: CachedChange | undefined, next: CachedChange): ItemEvent[] {
  if (!prev) {
    return next.state === 'open' || next.state === 'draft'
      ? [{ type: 'opened', detail: { kind: 'change', author: next.author, draft: next.state === 'draft' } }]
      : []
  }
  const out: ItemEvent[] = []
  const wasOpen = prev.state === 'open' || prev.state === 'draft'
  const isOpen = next.state === 'open' || next.state === 'draft'
  if (prev.state !== next.state) {
    if (next.state === 'merged') out.push({ type: 'merged', detail: { into: next.base.branch } })
    else if (next.state === 'closed') out.push({ type: 'closed', detail: { merged: false } })
    else if (!wasOpen && isOpen) out.push({ type: 'reopened', detail: {} })
  }
  if (isOpen && prev.head.sha && next.head.sha && prev.head.sha !== next.head.sha) {
    out.push({ type: 'pushed', detail: { from: prev.head.sha, to: next.head.sha } })
  }
  const pc = prev.checks?.state
  const nc = next.checks?.state
  if (isOpen && nc === 'failing' && (pc !== 'failing' || prev.head.sha !== next.head.sha)) {
    out.push({ type: 'ci_failed', detail: { failed: next.checks?.failed ?? [], sha: next.head.sha } })
  } else if (isOpen && nc === 'passing' && pc !== 'passing') {
    out.push({ type: 'ci_passed', detail: { sha: next.head.sha, from: pc ?? 'none' } })
  }
  const prevReview = new Map(prev.reviewers.map((r) => [r.login, r.state]))
  for (const r of next.reviewers) {
    const was = prevReview.get(r.login)
    if (was === r.state) continue
    if (r.state === 'requested') out.push({ type: 'review_requested', detail: { login: r.login } })
    else out.push({ type: 'reviewed', detail: { login: r.login, state: r.state } })
  }
  if (isOpen && next.mergeable === false && prev.mergeable !== false) {
    out.push({ type: 'conflict', detail: { base: next.base.branch } })
  }
  const pb = prev.compare?.behind ?? 0
  const nb = next.compare?.behind ?? 0
  if (isOpen && nb > pb) out.push({ type: 'behind_base', detail: { base: next.base.branch, behind: nb } })
  const labels = added(prev.labels, next.labels)
  if (labels.length) out.push({ type: 'labelled', detail: { added: labels } })
  const ass = added(prev.assignees, next.assignees)
  const unass = added(next.assignees, prev.assignees)
  if (ass.length || unass.length) out.push({ type: 'assigned', detail: { added: ass, removed: unass } })
  const prevRefs = new Set(prev.references.map(refKey))
  for (const r of next.references) {
    if (!prevRefs.has(refKey(r))) out.push({ type: 'referenced', detail: { by: refKey(r), byKind: r.kind } })
  }
  return out
}

export function diffIssue(prev: CachedIssue | undefined, next: CachedIssue): ItemEvent[] {
  if (!prev) {
    return next.state === 'open' ? [{ type: 'opened', detail: { kind: 'issue', author: next.author } }] : []
  }
  const out: ItemEvent[] = []
  if (prev.state !== next.state) {
    if (next.state === 'closed') out.push({ type: 'closed', detail: { reason: next.closedReason ?? 'completed' } })
    else out.push({ type: 'reopened', detail: {} })
  }
  const labels = added(prev.labels, next.labels)
  if (labels.length) out.push({ type: 'labelled', detail: { added: labels } })
  const ass = added(prev.assignees, next.assignees)
  const unass = added(next.assignees, prev.assignees)
  if (ass.length || unass.length) out.push({ type: 'assigned', detail: { added: ass, removed: unass } })
  const prevRefs = new Set(prev.references.map(refKey))
  for (const r of next.references) {
    if (!prevRefs.has(refKey(r))) out.push({ type: 'referenced', detail: { by: refKey(r), byKind: r.kind } })
  }
  return out
}
