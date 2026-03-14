// Event Stream Service — ring buffer, query, stats, subscribe

import type { EventBus, BusEvent } from '@sovereign/core'

export interface EventStreamEntry {
  id: number
  capturedAt: number
  event: BusEvent
}

export interface EventStreamFilter {
  type?: string
  source?: string
  since?: number
  until?: number
  entityId?: string
  limit?: number
  offset?: number
}

export interface EventStreamStats {
  totalCaptured: number
  rate: { '1m': number; '5m': number; '1h': number }
  byType: Record<string, number>
  bySource: Record<string, number>
}

export type EventStreamSubscriber = (entry: EventStreamEntry) => void

export interface EventStream {
  query(filter?: EventStreamFilter): EventStreamEntry[]
  stats(): EventStreamStats
  subscribe(handler: EventStreamSubscriber, filter?: EventStreamFilter): () => void
  getBuffer(): EventStreamEntry[]
  dispose(): void
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function matchesFilter(entry: EventStreamEntry, filter?: EventStreamFilter): boolean {
  if (!filter) return true
  if (filter.type) {
    const re = wildcardToRegex(filter.type)
    if (!re.test(entry.event.type)) return false
  }
  if (filter.source && entry.event.source !== filter.source) return false
  if (filter.since && entry.capturedAt < filter.since) return false
  if (filter.until && entry.capturedAt > filter.until) return false
  if (filter.entityId) {
    const payload = entry.event.payload as Record<string, unknown> | null
    if (!payload || payload.entityId !== filter.entityId) return false
  }
  return true
}

export interface EventStreamOptions {
  capacity?: number
}

export function createEventStream(bus: EventBus, options?: EventStreamOptions): EventStream {
  const capacity = options?.capacity ?? 5000
  const buffer: EventStreamEntry[] = []
  let nextId = 1
  let totalCaptured = 0
  const subscribers = new Set<{ handler: EventStreamSubscriber; filter?: EventStreamFilter }>()

  const capture = (event: BusEvent): void => {
    const entry: EventStreamEntry = {
      id: nextId++,
      capturedAt: Date.now(),
      event
    }
    totalCaptured++

    buffer.push(entry)
    if (buffer.length > capacity) buffer.shift()

    // Notify subscribers
    for (const sub of subscribers) {
      if (matchesFilter(entry, sub.filter)) {
        sub.handler(entry)
      }
    }
  }

  // Capture via bus wildcard, async to not block
  const unsub = bus.on('*', (event) => {
    queueMicrotask(() => capture(event))
  })

  const query = (filter?: EventStreamFilter): EventStreamEntry[] => {
    let results = buffer.filter((e) => matchesFilter(e, filter))
    // newest first
    results = results.slice().reverse()
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? results.length
    return results.slice(offset, offset + limit)
  }

  const stats = (): EventStreamStats => {
    const now = Date.now()
    const oneMin = now - 60_000
    const fiveMin = now - 300_000
    const oneHour = now - 3_600_000

    let rate1m = 0
    let rate5m = 0
    let rate1h = 0
    const byType: Record<string, number> = {}
    const bySource: Record<string, number> = {}

    for (const entry of buffer) {
      if (entry.capturedAt >= oneHour) rate1h++
      if (entry.capturedAt >= fiveMin) {
        rate5m++
        byType[entry.event.type] = (byType[entry.event.type] ?? 0) + 1
        bySource[entry.event.source] = (bySource[entry.event.source] ?? 0) + 1
      }
      if (entry.capturedAt >= oneMin) rate1m++
    }

    return { totalCaptured, rate: { '1m': rate1m, '5m': rate5m, '1h': rate1h }, byType, bySource }
  }

  const subscribe = (handler: EventStreamSubscriber, filter?: EventStreamFilter): (() => void) => {
    const sub = { handler, filter }
    subscribers.add(sub)
    return () => {
      subscribers.delete(sub)
    }
  }

  const getBuffer = (): EventStreamEntry[] => [...buffer]

  const dispose = (): void => {
    unsub()
    subscribers.clear()
  }

  return { query, stats, subscribe, getBuffer, dispose }
}
