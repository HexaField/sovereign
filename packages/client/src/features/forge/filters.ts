// Filters — pure. Values within one filter OR together; filters AND together.
// Non-matching nodes hide, or dim when `dim` is set.

import type { AgentOverlay, ForgeFilters, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { DAY_MS } from './layout.js'

export interface FilterContext {
  /** The membrane's forge login, for "requested from me". */
  me?: string
  overlays?: Map<string, AgentOverlay>
  now: number
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
  if (!some(f.workstreams, n.workstreams)) return false
  if (!agentMatches(f.agent, ctx.overlays?.get(n.id))) return false
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
  const matched = new Set<string>()
  for (const n of nodes) if (matchesFilters(n, f, ctx)) matched.add(n.id)
  if (f.dim) {
    const visible = new Set(nodes.map((n) => n.id))
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
    !!f.agent ||
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

/** Add the value to a list filter, or take it out if present; an emptied list is removed. */
export function toggleFilterValue(f: ForgeFilters, key: ListFilterKey, value: string): ForgeFilters {
  const cur = (f[key] as string[] | undefined) ?? []
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]
  const out = { ...f } as Record<string, unknown>
  if (next.length) out[key] = next
  else delete out[key]
  return out as ForgeFilters
}

export function clearFilters(f: ForgeFilters): ForgeFilters {
  return f.dim ? { dim: true } : {}
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
  workstreams: FilterOption[]
}

/** The values present in the loaded graph, with counts, most common first. */
export function filterOptions(nodes: WorkNode[], streams: WorkStream[]): FilterOptions {
  const tally = () => new Map<string, number>()
  const t = {
    repos: tally(),
    states: tally(),
    zones: tally(),
    authors: tally(),
    assignees: tally(),
    reviewers: tally(),
    labels: tally(),
    workstreams: tally()
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
    for (const s of new Set(n.workstreams)) add(t.workstreams, s)
  }
  const names = new Map(streams.map((s) => [s.id, s.name]))
  const list = (m: Map<string, number>, label: (v: string) => string = (v) => v): FilterOption[] =>
    [...m.entries()]
      .map(([value, count]) => ({ value, label: label(value), count }))
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
    labels: list(t.labels),
    workstreams: list(t.workstreams, (v) => names.get(v) ?? v)
  }
}

/** One-click stream focus: the stream's members and their direct neighbours. */
export function streamFocus(streamId: string, nodes: WorkNode[], edges: WorkEdge[]): Set<string> {
  const members = new Set(
    nodes.filter((n) => n.workstreams.includes(streamId) || n.taskId === streamId).map((n) => n.id)
  )
  const out = new Set(members)
  const known = new Set(nodes.map((n) => n.id))
  for (const e of edges) {
    if (members.has(e.from) && known.has(e.to)) out.add(e.to)
    if (members.has(e.to) && known.has(e.from)) out.add(e.from)
  }
  return out
}
