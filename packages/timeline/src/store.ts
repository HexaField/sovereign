// Timeline storage: append-only JSONL, one file per UTC day
// (`<dir>/YYYY-MM-DD.jsonl`), plus an in-memory ring of the newest entries.
// The ring always holds the newest `ringSize` entries in order, so any query
// whose answer lies inside it never touches the disk; older pages read the
// day files, newest first. Day files older than `retentionDays` are deleted.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { TimelineEntry, TimelinePage } from '@sovereign/core'
import type { TimelineDraft } from './mapping.js'

export const DEFAULT_RING_SIZE = 2000
export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 1000

export interface TimelineQuery {
  /** Inclusive lower bound (ISO). */
  since?: string
  /** Exclusive upper bound (ISO). */
  until?: string
  kinds?: string[]
  origins?: string[]
  limit?: number
  /** An entry id: only entries older than it (the previous page's `next`). */
  before?: string
}

export interface TimelineStore {
  append(d: TimelineDraft): TimelineEntry
  query(q: TimelineQuery): TimelinePage
  /** The in-memory entries, oldest first. */
  ring(): TimelineEntry[]
  /** Delete day files past retention (also drops them from the ring). */
  prune(): void
}

export interface TimelineStoreOptions {
  dir: string
  now?: () => number
  ringSize?: number
  retentionDays?: number
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAY_MS = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** `t<epoch ms, base 36>-<random>`. */
export const entryId = (ms: number) => `t${ms.toString(36)}-${randomBytes(3).toString('hex')}`

/** The time an id was minted at, or undefined for anything that is not an id. */
export function idTime(id: string): number | undefined {
  const m = /^t([0-9a-z]+)-[0-9a-z]+$/.exec(id)
  if (!m) return undefined
  const ms = parseInt(m[1]!, 36)
  return Number.isFinite(ms) ? ms : undefined
}

export function createTimelineStore(opts: TimelineStoreOptions): TimelineStore {
  const { dir } = opts
  const now = opts.now ?? Date.now
  const ringSize = opts.ringSize ?? DEFAULT_RING_SIZE
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS
  fs.mkdirSync(dir, { recursive: true })

  /** Day names (YYYY-MM-DD) with a file, newest first. */
  const days = (): string[] =>
    fs
      .readdirSync(dir)
      .map((f) => DAY_FILE.exec(f)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .reverse()

  function readDay(day: string): TimelineEntry[] {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(dir, `${day}.jsonl`), 'utf8')
    } catch {
      return []
    }
    const out: TimelineEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as TimelineEntry
        if (e && typeof e.id === 'string' && typeof e.at === 'string') out.push(e)
      } catch {
        /* a torn or hand-edited line */
      }
    }
    return out
  }

  function prune() {
    const cutoff = dayOf(now() - retentionDays * DAY_MS)
    for (const d of days()) {
      if (d < cutoff) fs.rmSync(path.join(dir, `${d}.jsonl`), { force: true })
    }
    const cutMs = Date.parse(`${cutoff}T00:00:00.000Z`)
    while (ring.length && Date.parse(ring[0]!.at) < cutMs) ring.shift()
  }

  // The ring: the newest entries, oldest first.
  let ring: TimelineEntry[] = []
  prune()
  for (const d of days()) {
    ring = [...readDay(d), ...ring]
    if (ring.length >= ringSize) break
  }
  ring.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (ring.length > ringSize) ring = ring.slice(-ringSize)
  /** Whether the ring holds every stored entry (no older ones on disk). */
  let complete = ring.length < ringSize
  let lastMs = ring.length ? Date.parse(ring[ring.length - 1]!.at) : -Infinity

  function append(d: TimelineDraft): TimelineEntry {
    const parsed = Date.parse(d.at)
    // Strictly increasing: the time orders ids, and a `before` cursor never skips a twin.
    const ms = Math.max(Number.isFinite(parsed) ? parsed : now(), lastMs + 1)
    lastMs = ms
    const entry: TimelineEntry = { id: entryId(ms), ...d, at: new Date(ms).toISOString() }
    fs.appendFileSync(path.join(dir, `${dayOf(ms)}.jsonl`), `${JSON.stringify(entry)}\n`)
    ring.push(entry)
    if (ring.length > ringSize) {
      ring.shift()
      complete = false
    }
    return entry
  }

  function query(q: TimelineQuery): TimelinePage {
    const limit = Math.min(Math.max(1, q.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const lower = q.since ? Date.parse(q.since) : -Infinity
    const beforeMs = q.before ? (idTime(q.before) ?? Infinity) : Infinity
    const upper = Math.min(q.until ? Date.parse(q.until) : Infinity, beforeMs)
    const kinds = q.kinds?.length ? new Set(q.kinds) : undefined
    const origins = q.origins?.length ? new Set(q.origins) : undefined
    const matches = (e: TimelineEntry) => {
      const t = Date.parse(e.at)
      return t >= lower && t < upper && (!kinds || kinds.has(e.kind)) && (!origins || origins.has(e.origin ?? 'system'))
    }

    const out: TimelineEntry[] = []
    for (let i = ring.length - 1; i >= 0 && out.length <= limit; i--) {
      const e = ring[i]!
      if (Date.parse(e.at) < lower) break
      if (matches(e)) out.push(e)
    }
    const ringStart = ring.length ? Date.parse(ring[0]!.at) : Infinity
    if (out.length <= limit && !complete && lower < ringStart) {
      // Past the ring: the day files, newest first, below what the ring covers.
      const top = Math.min(upper, ringStart)
      const topDay = Number.isFinite(top) ? dayOf(top) : '9999-99-99'
      const lowDay = Number.isFinite(lower) ? dayOf(lower) : ''
      for (const d of days()) {
        if (out.length > limit || d < lowDay) break
        if (d > topDay) continue
        const older = readDay(d)
          .filter((e) => Date.parse(e.at) < ringStart && matches(e))
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        out.push(...older)
      }
    }
    const more = out.length > limit
    const entries = out.slice(0, limit)
    return { entries, more, ...(more ? { next: entries[entries.length - 1]!.id } : {}) }
  }

  return { append, query, ring: () => [...ring], prune }
}
