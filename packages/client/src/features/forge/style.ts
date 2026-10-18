// Colours and line styles — pure. Canvas cannot read CSS variables directly,
// so the renderer gets a resolved Palette (see readPalette in ForgeCanvas).

import type {
  AgentOverlay,
  ChecksState,
  EpicStatus,
  ReviewState,
  WorkEdge,
  WorkNode,
  WorkNodeState
} from '@sovereign/core'

export interface Palette {
  bg: string
  raised: string
  border: string
  text: string
  muted: string
  accent: string
  past: string
  future: string
}

export const DEFAULT_PALETTE: Palette = {
  bg: '#0f1115',
  raised: '#171a21',
  border: '#2a2f3a',
  text: '#e5e7eb',
  muted: '#8b93a1',
  accent: '#60a5fa',
  past: 'rgba(148,163,184,0.05)',
  future: 'rgba(168,85,247,0.05)'
}

export const STATE_COLORS: Record<WorkNodeState, string> = {
  open: '#22c55e',
  draft: '#9ca3af',
  merged: '#a855f7',
  closed: '#ef4444',
  planned: '#f59e0b',
  done: '#a855f7',
  in_progress: '#3b82f6',
  paused: '#eab308',
  cancelled: '#6b7280'
}

/** The coloured label of an epic's status: planned grey, active green, paused amber, archived muted. */
export const EPIC_STATUS_COLORS: Record<EpicStatus, { fg: string; bg: string }> = {
  planned: { fg: '#9ca3af', bg: 'rgba(156,163,175,0.15)' },
  active: { fg: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
  paused: { fg: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  archived: { fg: '#6b7280', bg: 'rgba(107,114,128,0.10)' }
}

export const EPIC_STATUS_LABELS: Record<EpicStatus, string> = {
  active: 'Active',
  planned: 'Planned',
  paused: 'Paused',
  archived: 'Archived'
}

export const CI_COLORS: Record<ChecksState, string | null> = {
  passing: '#22c55e',
  failing: '#ef4444',
  pending: '#f59e0b',
  none: null
}

export const REVIEW_COLORS: Record<ReviewState, string> = {
  approved: '#22c55e',
  changes_requested: '#ef4444',
  requested: '#60a5fa',
  commented: '#9ca3af',
  dismissed: '#6b7280'
}

export const RING_COLORS = {
  working: '#22c55e',
  'waiting-ci': '#f59e0b',
  'waiting-review': '#3b82f6',
  idle: '#9ca3af'
} as const

export type RingKind = keyof typeof RING_COLORS

export interface Ring {
  kind: RingKind
  color: string
  /** Subagents are running: the ring pulses. */
  pulse: boolean
}

/**
 * The agent ring: green while the owner thread works, amber while it waits on
 * CI, blue on review, grey when assigned and idle. Subagents make it pulse
 * (and, with no owner thread, count as working).
 */
export function ringFor(o: AgentOverlay | undefined): Ring | null {
  if (!o) return null
  const pulse = o.subagents.length > 0
  let kind: RingKind | null = null
  if (o.thread && (o.thread.status === 'working' || o.thread.status === 'thinking')) kind = 'working'
  else if (o.waitingOn === 'ci' || o.ciWatch?.state === 'waiting') kind = 'waiting-ci'
  else if (o.waitingOn === 'review') kind = 'waiting-review'
  else if (o.thread) kind = 'idle'
  else if (pulse) kind = 'working'
  return kind ? { kind, color: RING_COLORS[kind], pulse } : null
}

export interface EdgeStyle {
  color: string
  dash: number[]
  width: number
}

const GREY = '#8b93a1'
const PURPLE = '#a855f7'

/**
 * Solid for base, merged-into and paired; dashed grey for references, plans,
 * subtasks and `closes` on an open issue; dashed purple for `related`.
 */
export function edgeStyle(e: WorkEdge, to: WorkNode | undefined): EdgeStyle {
  switch (e.kind) {
    case 'base':
      return { color: '#60a5fa', dash: [], width: 2 }
    case 'merged-into':
      return { color: PURPLE, dash: [], width: 1.5 }
    case 'paired':
      return { color: '#f59e0b', dash: [], width: 2 }
    case 'related':
      return { color: PURPLE, dash: [6, 5], width: 1.5 }
    case 'closes':
      return to && to.state !== 'open' ? { color: GREY, dash: [], width: 1 } : { color: GREY, dash: [5, 4], width: 1 }
    case 'references':
    case 'plans':
    case 'subtask':
    default:
      return { color: GREY, dash: [5, 4], width: 1 }
  }
}

/** A card in the lane of an epic it is only related to (not owned by): a dashed purple border, as a `related` edge. */
export const RELATED_CARD = { color: PURPLE, dash: [4, 3] }

export function initials(login: string): string {
  const parts = login.split(/[-_.\s]+/).filter(Boolean)
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : login.slice(0, 2)
  return s.toUpperCase()
}

/** A review summary for the badge: the strongest state any reviewer holds. */
export function reviewSummary(n: WorkNode): ReviewState | null {
  const order: ReviewState[] = ['changes_requested', 'approved', 'requested', 'commented']
  for (const s of order) if (n.reviewers.some((r) => r.state === s)) return s
  return null
}

export const EDGE_LABELS: Record<WorkEdge['kind'], string> = {
  base: 'Stacked on',
  'merged-into': 'Merged into',
  closes: 'Closes',
  references: 'References',
  paired: 'Paired with',
  plans: 'Plans',
  subtask: 'Subtask',
  related: 'Related (rethink)'
}

/** Reverse-direction labels, for the card's "linked nodes" list. */
export const EDGE_LABELS_IN: Record<WorkEdge['kind'], string> = {
  base: 'Stacked under it',
  'merged-into': 'Merged from',
  closes: 'Closed by',
  references: 'Referenced by',
  paired: 'Paired with',
  plans: 'Planned in',
  subtask: 'Parent',
  related: 'Related (rethink)'
}
