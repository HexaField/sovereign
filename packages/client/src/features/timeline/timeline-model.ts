// Timeline panel model — pure: formatting, filters, day groups, live inserts.

import { TIMELINE_KINDS, type TimelineEntry, type TimelineKind, type TurnOrigin } from '@sovereign/core/timeline'

export type OriginGroup = 'user' | 'automated' | 'subagent'

export const ORIGIN_GROUPS: readonly OriginGroup[] = ['user', 'automated', 'subagent']

export const ORIGIN_LABELS: Record<OriginGroup, string> = { user: 'User', automated: 'Automated', subagent: 'Subagent' }

/** The raw origins each chip stands for (what the server filters on). */
const ORIGINS_OF: Record<OriginGroup, TurnOrigin[]> = {
  user: ['user'],
  automated: ['cron', 'rethink', 'agent', 'system'],
  subagent: ['subagent']
}

export interface TimelineFilters {
  kinds: TimelineKind[]
  origins: OriginGroup[]
}

export const DEFAULT_FILTERS: TimelineFilters = { kinds: [...TIMELINE_KINDS], origins: [...ORIGIN_GROUPS] }

export const FILTERS_KEY = 'sovereign:timeline:filters'

export const KIND_META: Record<TimelineKind, { icon: string; color: string; label: string }> = {
  forge: { icon: '⚒', color: 'var(--c-accent)', label: 'Forge' },
  github: { icon: '●', color: 'var(--c-success)', label: 'CI' },
  agent: { icon: '◆', color: 'var(--c-info)', label: 'Agents' },
  subagent: { icon: '◇', color: 'var(--c-amber)', label: 'Subagents' },
  scheduler: { icon: '⏱', color: 'var(--c-warning)', label: 'Scheduler' },
  system: { icon: '⬡', color: 'var(--c-text-muted)', label: 'System' }
}

/** A failure reads in the error colour whatever its kind. */
export function entryColor(e: Pick<TimelineEntry, 'kind' | 'action'>): string {
  if (/(failed|ci_failed|timed-out|conflict)$/.test(e.action)) return 'var(--c-error)'
  return KIND_META[e.kind]?.color ?? 'var(--c-text-muted)'
}

export function formatRelative(at: string, now: number): string {
  const diff = Math.max(0, now - Date.parse(at))
  if (diff < 60_000) return 'now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`
  return `${Math.floor(diff / 86400_000)}d`
}

export function formatAbsolute(at: string): string {
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

export type EntryTarget = { kind: 'thread'; threadId: string } | { kind: 'url'; url: string }

/** What a click on the line opens: its thread, else its url (http(s) only), else nothing. */
export function entryTarget(e: TimelineEntry): EntryTarget | null {
  if (e.threadId) return { kind: 'thread', threadId: e.threadId }
  if (e.url && /^https?:\/\//i.test(e.url)) return { kind: 'url', url: e.url }
  return null
}

export function originGroup(o?: TurnOrigin): OriginGroup {
  if (o === 'user') return 'user'
  if (o === 'subagent') return 'subagent'
  return 'automated'
}

export function matchesFilters(e: TimelineEntry, f: TimelineFilters): boolean {
  return f.kinds.includes(e.kind) && f.origins.includes(originGroup(e.origin))
}

/** Flip a chip; the last one on stays on (an empty filter would show nothing). */
export function toggle<T>(list: readonly T[], v: T): T[] {
  if (list.includes(v)) return list.length > 1 ? list.filter((x) => x !== v) : [...list]
  return [...list, v]
}

export function parseFilters(raw: string | null): TimelineFilters {
  if (!raw) return DEFAULT_FILTERS
  try {
    const p = JSON.parse(raw) as Partial<TimelineFilters>
    const kinds = (Array.isArray(p.kinds) ? p.kinds : []).filter((k): k is TimelineKind =>
      TIMELINE_KINDS.includes(k as TimelineKind)
    )
    const origins = (Array.isArray(p.origins) ? p.origins : []).filter((o): o is OriginGroup =>
      ORIGIN_GROUPS.includes(o as OriginGroup)
    )
    return {
      kinds: kinds.length ? kinds : DEFAULT_FILTERS.kinds,
      origins: origins.length ? origins : DEFAULT_FILTERS.origins
    }
  } catch {
    return DEFAULT_FILTERS
  }
}

/** Query parameters for `GET /api/timeline`: only what the chips narrow. */
export function queryOf(f: TimelineFilters): { kinds?: string; origins?: string } {
  const q: { kinds?: string; origins?: string } = {}
  if (f.kinds.length < TIMELINE_KINDS.length) q.kinds = TIMELINE_KINDS.filter((k) => f.kinds.includes(k)).join(',')
  if (f.origins.length < ORIGIN_GROUPS.length)
    q.origins = ORIGIN_GROUPS.filter((g) => f.origins.includes(g))
      .flatMap((g) => ORIGINS_OF[g])
      .join(',')
  return q
}

const localDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface DayGroup {
  day: string
  label: string
  entries: TimelineEntry[]
}

/** Newest-first entries in local days: Today, Yesterday, then "Tue 20 Oct". */
export function groupByDay(entries: readonly TimelineEntry[], now: number): DayGroup[] {
  const today = localDay(now)
  const yesterday = localDay(new Date(now).setDate(new Date(now).getDate() - 1))
  const groups: DayGroup[] = []
  for (const e of entries) {
    const ms = Date.parse(e.at)
    const day = localDay(ms)
    let g = groups[groups.length - 1]
    if (!g || g.day !== day) {
      const label =
        day === today
          ? 'Today'
          : day === yesterday
            ? 'Yesterday'
            : new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
      g = { day, label, entries: [] }
      groups.push(g)
    }
    g.entries.push(e)
  }
  return groups
}

const newestFirst = (a: TimelineEntry, b: TimelineEntry) => Date.parse(b.at) - Date.parse(a.at)

/** A live entry: on top (in time order), once. Returns the same list when it is already there. */
export function insertLive(list: readonly TimelineEntry[], e: TimelineEntry): TimelineEntry[] {
  if (list.some((x) => x.id === e.id)) return list as TimelineEntry[]
  const i = list.findIndex((x) => newestFirst(e, x) <= 0)
  return i < 0 ? [...list, e] : [...list.slice(0, i), e, ...list.slice(i)]
}

/** An older page below what is shown, minus anything already there. */
export function appendOlder(list: readonly TimelineEntry[], older: readonly TimelineEntry[]): TimelineEntry[] {
  const seen = new Set(list.map((e) => e.id))
  return [...list, ...older.filter((e) => !seen.has(e.id))]
}
