import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createEventStream, type EventStream } from './event-stream.js'
import type { EventBus, BusEvent, BusHandler } from '@sovereign/core'

function createTestBus(): EventBus & { _fire(event: BusEvent): void } {
  const handlers: Array<{ pattern: string; handler: BusHandler }> = []
  return {
    emit: vi.fn(),
    on(pattern: string, handler: BusHandler) {
      const entry = { pattern, handler }
      handlers.push(entry)
      return () => {
        const idx = handlers.indexOf(entry)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },
    once: vi.fn() as any,
    replay: vi.fn() as any,
    history: vi.fn().mockReturnValue([]),
    _fire(event: BusEvent) {
      for (const h of handlers) {
        if (h.pattern === '*' || h.pattern === event.type) h.handler(event)
      }
    }
  } as any
}

function makeEvent(type: string, source = 'test', payload: unknown = {}): BusEvent {
  return { type, timestamp: new Date().toISOString(), source, payload }
}

describe('Event Stream Routes', () => {
  let bus: ReturnType<typeof createTestBus>
  let es: EventStream

  beforeEach(() => {
    bus = createTestBus()
    es = createEventStream(bus)
  })

  afterEach(() => {
    es.dispose()
  })

  describe('GET /api/system/events', () => {
    it('returns recent events', async () => {
      bus._fire(makeEvent('test.event'))
      await new Promise((r) => setTimeout(r, 10))
      const events = es.query()
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].event.type).toBe('test.event')
    })

    it('supports type filter query param', async () => {
      bus._fire(makeEvent('issue.created'))
      bus._fire(makeEvent('pr.merged'))
      await new Promise((r) => setTimeout(r, 10))
      const events = es.query({ type: 'issue.*' })
      expect(events).toHaveLength(1)
      expect(events[0].event.type).toBe('issue.created')
    })

    it('supports source filter query param', async () => {
      bus._fire(makeEvent('a', 'git'))
      bus._fire(makeEvent('b', 'issues'))
      await new Promise((r) => setTimeout(r, 10))
      const events = es.query({ source: 'git' })
      expect(events).toHaveLength(1)
    })

    it('supports since/until query params', async () => {
      bus._fire(makeEvent('a'))
      await new Promise((r) => setTimeout(r, 20))
      const since = Date.now()
      await new Promise((r) => setTimeout(r, 20))
      bus._fire(makeEvent('b'))
      await new Promise((r) => setTimeout(r, 10))
      const events = es.query({ since })
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].event.type).toBe('b')
    })

    it('supports limit/offset pagination', async () => {
      for (let i = 0; i < 10; i++) bus._fire(makeEvent(`e.${i}`))
      await new Promise((r) => setTimeout(r, 10))
      const events = es.query({ limit: 3, offset: 0 })
      expect(events).toHaveLength(3)
    })
  })

  describe('GET /api/system/events/stats', () => {
    it('returns rate and counts', async () => {
      bus._fire(makeEvent('issue.created', 'issues'))
      bus._fire(makeEvent('pr.merged', 'review'))
      await new Promise((r) => setTimeout(r, 10))
      const stats = es.stats()
      expect(stats.totalCaptured).toBe(2)
      expect(stats.rate['1m']).toBe(2)
      expect(stats.byType['issue.created']).toBe(1)
      expect(stats.bySource['issues']).toBe(1)
    })
  })
})
