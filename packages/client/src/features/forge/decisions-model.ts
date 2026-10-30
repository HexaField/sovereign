// Decisions view logic, DOM-less: filter, sort, group-by, the bulk resolve
// payload, the delivery summary and where a source link goes. Filter state is
// the browser's own (localStorage), never a server-saved Forge view.

import type { Decision, DecisionDelivery, DecisionSource, DecisionSourceKind } from '@sovereign/core'

export type DecisionStatusFilter = 'open' | 'resolved' | 'all'
export type DecisionSort = 'newest' | 'oldest' | 'group' | 'thread' | 'source'
export type DecisionGroupBy = 'none' | 'group' | 'thread'

export const DECISION_SORTS: Array<{ value: DecisionSort; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'group', label: 'Group' },
  { value: 'thread', label: 'Thread' },
  { value: 'source', label: 'Source' }
]
export const DECISION_GROUP_BYS: Array<{ value: DecisionGroupBy; label: string }> = [
  { value: 'none', label: 'No grouping' },
  { value: 'group', label: 'By group' },
  { value: 'thread', label: 'By thread' }
]
export const SOURCE_KIND_LABELS: Record<DecisionSourceKind, string> = {
  plan: 'Plan',
  thread: 'Thread',
  node: 'Forge item',
  other: 'Other'
}

/** The empty value in the group and thread filters: decisions without one. */
export const NONE = ''

export interface DecisionFilters {
  status: DecisionStatusFilter
  /** Group names; NONE = no group. Empty: every group. */
  groups: string[]
  /** Thread ids; NONE = no thread. */
  threads: string[]
  /** 'none' = no source. */
  sourceKinds: Array<DecisionSourceKind | 'none'>
  q: string
  sort: DecisionSort
  groupBy: DecisionGroupBy
}

export const DEFAULT_DECISION_FILTERS: DecisionFilters = {
  status: 'open',
  groups: [],
  threads: [],
  sourceKinds: [],
  q: '',
  sort: 'newest',
  groupBy: 'none'
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])

/** Filters saved in localStorage; anything unreadable falls back to the defaults. */
export function parseDecisionFilters(raw: string | null | undefined): DecisionFilters {
  let v: Record<string, unknown> = {}
  try {
    const parsed = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object') v = parsed
  } catch {
    /* defaults */
  }
  const d = DEFAULT_DECISION_FILTERS
  return {
    status: pick(v.status, ['open', 'resolved', 'all'] as const, d.status),
    groups: strings(v.groups),
    threads: strings(v.threads),
    sourceKinds: strings(v.sourceKinds).filter((k): k is DecisionSourceKind | 'none' =>
      ['plan', 'thread', 'node', 'other', 'none'].includes(k)
    ),
    q: typeof v.q === 'string' ? v.q : '',
    sort: pick(
      v.sort,
      DECISION_SORTS.map((s) => s.value),
      d.sort
    ),
    groupBy: pick(
      v.groupBy,
      DECISION_GROUP_BYS.map((g) => g.value),
      d.groupBy
    )
  }
}

/**
 * The phone Filters button's badge in the Decisions view: a status other than
 * open, each picked group, thread and source kind, and the search text.
 * Sort and group-by order the list without hiding anything, so they do not count.
 */
export function activeDecisionFilterCount(f: DecisionFilters): number {
  return (
    (f.status !== DEFAULT_DECISION_FILTERS.status ? 1 : 0) +
    f.groups.length +
    f.threads.length +
    f.sourceKinds.length +
    (f.q.trim() ? 1 : 0)
  )
}

export type ThreadName = (threadId: string) => string | undefined

export const threadLabel = (id: string | undefined, name: ThreadName): string => (id ? (name(id) ?? id) : 'No thread')
export const groupLabel = (group: string | undefined): string => group ?? 'No group'
export const sourceText = (s: DecisionSource | undefined): string => (s ? (s.label ?? s.ref) : '')

export function filterDecisions(list: Decision[], f: DecisionFilters, name: ThreadName = () => undefined): Decision[] {
  const q = f.q.trim().toLowerCase()
  return list.filter((d) => {
    if (f.status !== 'all' && d.status !== f.status) return false
    if (f.groups.length && !f.groups.includes(d.group ?? NONE)) return false
    if (f.threads.length && !f.threads.includes(d.threadId ?? NONE)) return false
    if (f.sourceKinds.length && !f.sourceKinds.includes(d.source?.kind ?? 'none')) return false
    if (!q) return true
    const hay = [
      d.question,
      d.context,
      ...(d.options ?? []),
      d.group,
      d.resolution,
      sourceText(d.source),
      d.threadId ? threadLabel(d.threadId, name) : undefined
    ]
    return hay.some((s) => s?.toLowerCase().includes(q))
  })
}

const newest = (a: Decision, b: Decision) => b.createdAt.localeCompare(a.createdAt)
/** Named keys first (alphabetically, case-insensitive), then the ones without. */
const byKey = (ka: string | undefined, kb: string | undefined): number => {
  if (ka === kb) return 0
  if (ka === undefined) return 1
  if (kb === undefined) return -1
  return ka.localeCompare(kb, undefined, { sensitivity: 'base', numeric: true })
}

export function sortDecisions(list: Decision[], sort: DecisionSort, name: ThreadName = () => undefined): Decision[] {
  const keyOf = (d: Decision): string | undefined => {
    if (sort === 'group') return d.group
    if (sort === 'thread') return d.threadId ? threadLabel(d.threadId, name) : undefined
    if (sort === 'source') return d.source ? `${d.source.kind} ${sourceText(d.source)}` : undefined
    return undefined
  }
  return [...list].sort((a, b) => {
    if (sort === 'oldest') return -newest(a, b)
    if (sort === 'newest') return newest(a, b)
    return byKey(keyOf(a), keyOf(b)) || newest(a, b)
  })
}

export interface DecisionSection {
  /** The group name or thread id; NONE for decisions without one; 'all' with no grouping. */
  key: string
  label: string
  items: Decision[]
}

/** Sections in the order their keys sort (named first); items keep the list's order. */
export function groupDecisionsBy(
  list: Decision[],
  by: DecisionGroupBy,
  name: ThreadName = () => undefined
): DecisionSection[] {
  if (by === 'none') return list.length ? [{ key: 'all', label: 'All', items: list }] : []
  const sections = new Map<string, DecisionSection>()
  for (const d of list) {
    const key = (by === 'group' ? d.group : d.threadId) ?? NONE
    const label = by === 'group' ? groupLabel(d.group) : threadLabel(d.threadId, name)
    const s = sections.get(key) ?? { key, label, items: [] }
    s.items.push(d)
    sections.set(key, s)
  }
  return [...sections.values()].sort((a, b) =>
    byKey(a.key === NONE ? undefined : a.label, b.key === NONE ? undefined : b.label)
  )
}

export interface Option {
  value: string
  label: string
  count: number
}

/** Choices for the group, thread and source-kind filters, from every decision of the status shown. */
export function decisionFilterOptions(
  list: Decision[],
  status: DecisionStatusFilter,
  name: ThreadName = () => undefined
): { groups: Option[]; threads: Option[]; sourceKinds: Option[] } {
  const of = list.filter((d) => status === 'all' || d.status === status)
  const count = (keyOf: (d: Decision) => string, labelOf: (d: Decision) => string): Option[] => {
    const m = new Map<string, Option>()
    for (const d of of) {
      const k = keyOf(d)
      const o = m.get(k) ?? { value: k, label: labelOf(d), count: 0 }
      o.count++
      m.set(k, o)
    }
    return [...m.values()].sort((a, b) =>
      byKey(
        a.value === NONE || a.value === 'none' ? undefined : a.label,
        b.value === NONE || b.value === 'none' ? undefined : b.label
      )
    )
  }
  return {
    groups: count(
      (d) => d.group ?? NONE,
      (d) => groupLabel(d.group)
    ),
    threads: count(
      (d) => d.threadId ?? NONE,
      (d) => threadLabel(d.threadId, name)
    ),
    sourceKinds: count(
      (d) => d.source?.kind ?? 'none',
      (d) => (d.source ? SOURCE_KIND_LABELS[d.source.kind] : 'No source')
    )
  }
}

/** Every distinct group name, for "Group as…". */
export const knownGroups = (list: Decision[]): string[] =>
  [...new Set(list.map((d) => d.group).filter((g): g is string => !!g))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )

export const toggleIn = <T>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

/** Select or clear every id of a section: all selected → clear them, else add them. */
export function toggleSection(selected: Set<string>, ids: string[]): Set<string> {
  const next = new Set(selected)
  const all = ids.length > 0 && ids.every((id) => next.has(id))
  for (const id of ids) {
    if (all) next.delete(id)
    else next.add(id)
  }
  return next
}

export const openCount = (list: Decision[]): number => list.filter((d) => d.status === 'open').length

/** An answer being written: an option picked from the chips, and/or a free-text note. */
export interface Draft {
  choice?: string
  note: string
}

/** The resolution a draft sends: the option, the note, or the option with the note on the next line. */
export function draftResolution(d: Draft | undefined): string {
  const note = d?.note.trim() ?? ''
  return [d?.choice, note].filter(Boolean).join('\n')
}

/** Pick an option (the note stays); picking the picked one again unpicks it. */
export function pickOption(d: Draft | undefined, option: string): Draft {
  const note = d?.note ?? ''
  return d?.choice === option ? { note } : { choice: option, note }
}

/** The open decisions with an answer, in list order: what one "Resolve and send" sends. */
export function answeredDecisions(list: Decision[], drafts: Record<string, Draft>): Decision[] {
  return list.filter((d) => d.status === 'open' && draftResolution(drafts[d.id]))
}

/**
 * The body of POST /api/forge/decisions/resolve for the picked decisions, in the order shown.
 * Every picked open decision needs a resolution; `missing` lists the ones without.
 */
export function resolvePayload(
  membrane: string,
  picked: Decision[],
  drafts: Record<string, Draft>
): { body: { membrane: string; items: Array<{ id: string; resolution: string }> }; missing: Decision[] } {
  const open = picked.filter((d) => d.status === 'open')
  const items = open.map((d) => ({ id: d.id, resolution: draftResolution(drafts[d.id]) }))
  return {
    body: { membrane, items: items.filter((i) => i.resolution) },
    missing: open.filter((_d, i) => !items[i].resolution)
  }
}

/** "Sent 2 messages: Indexer (2 decisions), Release (1 decision). 1 resolved without a thread." */
export function deliverySummary(
  result: { resolved: Decision[]; deliveries: DecisionDelivery[] },
  name: ThreadName = () => undefined
): string {
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`
  const ok = result.deliveries.filter((d) => d.sent)
  const failed = result.deliveries.filter((d) => !d.sent)
  const unthreaded = result.resolved.filter((d) => !d.threadId).length
  const parts = [`Resolved ${n(result.resolved.length, 'decision')}.`]
  if (ok.length)
    parts.push(
      `Sent ${n(ok.length, 'message')}: ${ok.map((d) => `${threadLabel(d.threadId, name)} (${n(d.ids.length, 'decision')})`).join(', ')}.`
    )
  else parts.push('No messages sent.')
  for (const f of failed) parts.push(`Could not reach ${threadLabel(f.threadId, name)}: ${f.error ?? 'failed'}.`)
  if (unthreaded) parts.push(`${n(unthreaded, 'decision')} had no thread.`)
  return parts.join(' ')
}

/** "just now", "5m", "3h", "2d", "6w". */
export function ageLabel(createdAt: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(createdAt))
  const m = Math.floor(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 14) return `${d}d`
  return `${Math.floor(d / 7)}w`
}

/** Where a source link goes: a thread, a work-graph node (a plan id is one), a file, or nowhere. */
export type SourceTarget =
  | { kind: 'thread'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'none' }

export function sourceTarget(s: DecisionSource | undefined): SourceTarget {
  if (!s) return { kind: 'none' }
  const ref = s.ref.trim()
  switch (s.kind) {
    case 'thread':
      return { kind: 'thread', id: ref }
    case 'node':
      return { kind: 'node', id: ref }
    case 'plan':
      if (ref.startsWith('plan:')) return { kind: 'node', id: ref }
      // An absolute or home path opens the file; a relative one is a plan node's "<project>/<path>".
      if (ref.startsWith('/') || ref.startsWith('~/')) return { kind: 'file', path: ref }
      return { kind: 'node', id: `plan:${ref}` }
    default:
      return { kind: 'none' }
  }
}
