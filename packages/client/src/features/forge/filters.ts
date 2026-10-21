// Filters — pure. Values within one filter OR together; filters AND together.
// Non-matching nodes hide, or dim when `dim` is set. Selected epics
// (`workstreams`) are not a filter here: they focus the canvas (streamFocus,
// epics-model.ts), so their members' neighbours can show too.

import type { AgentOverlay, ForgeFilters, WorkEdge, WorkNode } from '@sovereign/core'
import { leafState } from '@sovereign/core/forge'
import { DAY_MS } from './layout.js'

export interface FilterContext {
  /** The membrane's forge login, for "requested from me". */
  me?: string
  overlays?: Map<string, AgentOverlay>
  now: number
  /** Streams hidden as paused (`pausedStreams`): an item they alone own hides with them. */
  pausedStreams?: Set<string>
}

export interface FilterResult {
  /** Nodes drawn at all. */
  visible: Set<string>
  /** Drawn faded (dim mode only). */
  dimmed: Set<string>
  /** Nodes that pass every filter. */
  matched: Set<string>
}

const some = <T>(want: T[] | undefined, have: T[]): boolean => !want?.length || have.some((v) => want.includes(v))
const one = <T>(want: T[] | undefined, have: T | undefined): boolean =>
  !want?.length || (have !== undefined && want.includes(have))

export function nodeText(n: WorkNode): string {
  return [
    n.title,
    n.number !== undefined ? `#${n.number}` : '',
    n.repo ?? '',
    n.branch?.head ?? '',
    n.author ?? '',
    ...n.labels
  ]
    .join(' ')
    .toLowerCase()
}

export function agentMatches(f: ForgeFilters['agent'], o: AgentOverlay | undefined): boolean {
  if (!f) return true
  if (!o) return false
  if (f === 'any') return !!o.thread || o.subagents.length > 0
  if (f === 'waiting-ci') return o.waitingOn === 'ci' || o.ciWatch?.state === 'waiting'
  return o.waitingOn === 'review'
}

/** "Not in a tree": an open PR or issue that no (served) work stream owns. */
export function isOrphan(n: WorkNode): boolean {
  const open =
    n.kind === 'change' ? n.state === 'open' || n.state === 'draft' : n.kind === 'issue' && n.state === 'open'
  return open && n.workstreams.length === 0
}

/** Whether the user can pause the node, or resume it: an open PR, issue or task, or one already paused. */
export function pausable(n: WorkNode): boolean {
  return n.paused === true || leafState(n) === 'open'
}

/** Set aside, so hidden unless `showPaused`: a paused item, or one owned only by paused streams. */
export function isPausedOut(n: WorkNode, f: ForgeFilters, ctx: FilterContext): boolean {
  if (f.showPaused) return false
  if (n.paused) return true
  const hidden = ctx.pausedStreams
  return !!hidden?.size && n.workstreams.length > 0 && n.workstreams.every((id) => hidden.has(id))
}

export function matchesFilters(n: WorkNode, f: ForgeFilters, ctx: FilterContext): boolean {
  if (!one(f.repos, n.repo)) return false
  if (!one(f.states, n.state)) return false
  if (!one(f.zones, n.zone)) return false
  if (!one(f.authors, n.author)) return false
  if (!some(f.assignees, n.assignees)) return false
  if (
    !some(
      f.reviewers,
      n.reviewers.map((r) => r.login)
    )
  )
    return false
  if (f.requestedFromMe && !(ctx.me && n.reviewers.some((r) => r.login === ctx.me && r.state === 'requested')))
    return false
  if (!some(f.labels, n.labels)) return false
  if (!agentMatches(f.agent, ctx.overlays?.get(n.id))) return false
  if (f.orphans && !isOrphan(n)) return false
  if (f.updatedWithinDays !== undefined && f.updatedWithinDays > 0) {
    const t = Date.parse(n.updatedAt)
    if (!Number.isFinite(t) || t < ctx.now - f.updatedWithinDays * DAY_MS) return false
  }
  const q = f.text?.trim().toLowerCase()
  if (q) {
    const hay = nodeText(n)
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
  }
  return true
}

export function applyFilters(nodes: WorkNode[], f: ForgeFilters, ctx: FilterContext): FilterResult {
  // Paused work is hidden, not dimmed: the user set it aside
  const live = nodes.filter((n) => !isPausedOut(n, f, ctx))
  const matched = new Set<string>()
  for (const n of live) if (matchesFilters(n, f, ctx)) matched.add(n.id)
  if (f.dim) {
    const visible = new Set(live.map((n) => n.id))
    const dimmed = new Set([...visible].filter((id) => !matched.has(id)))
    return { visible, dimmed, matched }
  }
  return { visible: new Set(matched), dimmed: new Set(), matched }
}

/** True when the filters narrow anything (dim alone does not). */
export function hasActiveFilters(f: ForgeFilters): boolean {
  return (
    !!f.repos?.length ||
    !!f.states?.length ||
    !!f.zones?.length ||
    !!f.authors?.length ||
    !!f.assignees?.length ||
    !!f.reviewers?.length ||
    !!f.requestedFromMe ||
    !!f.labels?.length ||
    !!f.workstreams?.length ||
    !!f.epicStatus?.length ||
    !!f.agent ||
    !!f.orphans ||
    !!f.updatedWithinDays ||
    !!f.text?.trim()
  )
}

export type ListFilterKey =
  | 'repos'
  | 'states'
  | 'zones'
  | 'authors'
  | 'assignees'
  | 'reviewers'
  | 'labels'
  | 'workstreams'
  | 'epicStatus'

/** Add the value to a list filter, or take it out if present; an emptied list is removed. */
export function toggleFilterValue(f: ForgeFilters, key: ListFilterKey, value: string): ForgeFilters {
  const cur = (f[key] as string[] | undefined) ?? []
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
  const out = { ...f } as Record<string, unknown>
  if (next.length) out[key] = next
  else delete out[key]
  return out as ForgeFilters
}

/** Drop every filter and the epic selection; the display toggles (dim, paused, empty plans, epic neighbours, owned + related) stay. */
export function clearFilters(f: ForgeFilters): ForgeFilters {
  return {
    ...(f.dim ? { dim: true } : {}),
    ...(f.showPaused ? { showPaused: true } : {}),
    ...(f.showEmpty ? { showEmpty: true } : {}),
    ...(f.epicNeighbours === false ? { epicNeighbours: false } : {}),
    ...(f.epicRelated ? { epicRelated: true } : {})
  }
}

export interface FilterOption {
  value: string
  label: string
  count: number
}

export interface FilterOptions {
  repos: FilterOption[]
  states: FilterOption[]
  zones: FilterOption[]
  authors: FilterOption[]
  assignees: FilterOption[]
  reviewers: FilterOption[]
  labels: FilterOption[]
}

export type OptionKey = keyof FilterOptions

/** The values present in the loaded graph, with counts, most common first. */
export function filterOptions(nodes: WorkNode[]): FilterOptions {
  const tally = () => new Map<string, number>()
  const t = {
    repos: tally(),
    states: tally(),
    zones: tally(),
    authors: tally(),
    assignees: tally(),
    reviewers: tally(),
    labels: tally()
  }
  const add = (m: Map<string, number>, v: string | undefined) => {
    if (v) m.set(v, (m.get(v) ?? 0) + 1)
  }
  for (const n of nodes) {
    add(t.repos, n.repo)
    add(t.states, n.state)
    add(t.zones, n.zone)
    add(t.authors, n.author)
    for (const a of new Set(n.assignees)) add(t.assignees, a)
    for (const r of new Set(n.reviewers.map((x) => x.login))) add(t.reviewers, r)
    for (const l of new Set(n.labels)) add(t.labels, l)
  }
  const list = (m: Map<string, number>): FilterOption[] =>
    [...m.entries()]
      .map(([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  return {
    repos: list(t.repos),
    states: list(t.states),
    zones: ['past', 'present', 'future']
      .filter((z) => t.zones.has(z))
      .map((z) => ({ value: z, label: z, count: t.zones.get(z)! })),
    authors: list(t.authors),
    assignees: list(t.assignees),
    reviewers: list(t.reviewers),
    labels: list(t.labels)
  }
}

const OPTION_KEYS: OptionKey[] = ['repos', 'states', 'zones', 'authors', 'assignees', 'reviewers', 'labels']

export interface FilterMenu {
  key: OptionKey
  label: string
}

/** The chips always shown; the rest wait behind "More". */
export const PRIMARY_MENUS: FilterMenu[] = [
  { key: 'repos', label: 'Repo' },
  { key: 'states', label: 'State' },
  { key: 'assignees', label: 'Assignee' }
]
export const MORE_MENUS: FilterMenu[] = [
  { key: 'zones', label: 'Zone' },
  { key: 'authors', label: 'Author' },
  { key: 'reviewers', label: 'Reviewer' },
  { key: 'labels', label: 'Label' }
]

/** How many values are selected in the chips behind "More" (shown on the chip). */
export function moreActiveCount(f: ForgeFilters): number {
  return MORE_MENUS.reduce((n, m) => n + ((f[m.key] as string[] | undefined)?.length ?? 0), 0)
}

/**
 * Options in an order that holds while the user picks: values already listed
 * keep their place, with the count of the latest load (0 when it has none),
 * new values follow in `next`'s order, and a selected value never seen is
 * added at 0. A pick changes the saved view, which the server applies to the
 * window it serves: ordering by the fresh counts re-sorted the menu under the
 * cursor on every click, and dropped every value the pick filtered out.
 */
export function stableOptions(
  prev: FilterOptions | undefined,
  next: FilterOptions,
  selected: ForgeFilters
): FilterOptions {
  const out = {} as FilterOptions
  for (const key of OPTION_KEYS) {
    const fresh = new Map(next[key].map((o) => [o.value, o]))
    const chosen = new Set((selected[key] as string[] | undefined) ?? [])
    const list: FilterOption[] = []
    const seen = new Set<string>()
    for (const o of prev?.[key] ?? []) {
      list.push(fresh.get(o.value) ?? { ...o, count: 0 })
      seen.add(o.value)
    }
    for (const o of next[key]) {
      if (seen.has(o.value)) continue
      list.push(o)
      seen.add(o.value)
    }
    for (const v of chosen) if (!seen.has(v)) list.push({ value: v, label: v, count: 0 })
    out[key] = list
  }
  return out
}

/** Stream focus: the members of these streams (with `related`, the items related to them too) and, with `neighbours`, their direct neighbours. */
export function streamFocus(
  streamIds: string | string[],
  nodes: WorkNode[],
  edges: WorkEdge[],
  neighbours = true,
  related = false
): Set<string> {
  const ids = new Set(typeof streamIds === 'string' ? [streamIds] : streamIds)
  const members = new Set(
    nodes
      .filter(
        (n) =>
          n.workstreams.some((w) => ids.has(w)) ||
          (n.taskId !== undefined && ids.has(n.taskId)) ||
          (related && (n.relatedStreams ?? []).some((w) => ids.has(w)))
      )
      .map((n) => n.id)
  )
  const out = new Set(members)
  if (!neighbours) return out
  const known = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (members.has(e.from) && known.has(e.to)) out.add(e.to)
    if (members.has(e.to) && known.has(e.from)) out.add(e.from)
  }
  return out
}
