// Timeline service: subscribes to the bus events the mapping knows, stores
// each line (see store.ts) and hands it to listeners (the WS channel).

import path from 'node:path'
import type { EventBus, TimelineEntry, TimelinePage } from '@sovereign/core'
import { mapEvent, TIMELINE_EVENT_TYPES, type TimelineDraft } from './mapping.js'
import { createTimelineStore, type TimelineQuery } from './store.js'

export interface TimelineService {
  /** Subscribe to the bus, log a "Sovereign started" line, schedule the daily retention pass. */
  start(): void
  stop(): void
  /** Store one line (for callers outside the bus mapping, and tests). */
  record(d: TimelineDraft): TimelineEntry
  query(q: TimelineQuery): TimelinePage
  onEntry(cb: (e: TimelineEntry) => void): () => void
}

export interface TimelineServiceDeps {
  bus: EventBus
  /** Entries live in `<dataDir>/timeline`. */
  dataDir: string
  labelOf(threadId: string): string | undefined
  now?: () => number
  ringSize?: number
  retentionDays?: number
}

const PRUNE_EVERY_MS = 86_400_000

export function createTimelineService(deps: TimelineServiceDeps): TimelineService {
  const now = deps.now ?? Date.now
  const store = createTimelineStore({
    dir: path.join(deps.dataDir, 'timeline'),
    now,
    ...(deps.ringSize ? { ringSize: deps.ringSize } : {}),
    ...(deps.retentionDays ? { retentionDays: deps.retentionDays } : {})
  })
  const listeners = new Set<(e: TimelineEntry) => void>()
  let offs: Array<() => void> = []
  let pruneTimer: ReturnType<typeof setInterval> | undefined

  function record(d: TimelineDraft): TimelineEntry {
    const entry = store.append(d)
    for (const cb of listeners) {
      try {
        cb(entry)
      } catch (err) {
        console.warn('[timeline] listener failed:', (err as Error).message)
      }
    }
    return entry
  }

  return {
    start() {
      if (offs.length) return
      offs = TIMELINE_EVENT_TYPES.map((type) =>
        deps.bus.on(type, (event) => {
          for (const d of mapEvent(event, { labelOf: deps.labelOf })) record(d)
        })
      )
      record({
        at: new Date(now()).toISOString(),
        kind: 'system',
        action: 'server.started',
        title: 'Sovereign started',
        origin: 'system'
      })
      pruneTimer = setInterval(() => store.prune(), PRUNE_EVERY_MS)
      pruneTimer.unref?.()
    },
    stop() {
      for (const off of offs) off()
      offs = []
      if (pruneTimer) clearInterval(pruneTimer)
      pruneTimer = undefined
    },
    record,
    query: (q) => store.query(q),
    onEntry(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}
