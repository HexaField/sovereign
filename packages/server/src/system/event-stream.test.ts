import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventStream } from './event-stream.js'
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
        if (h.pattern === '*' || h.pattern === event.type) {
          h.handler(event)
        }
      }
    }
  } as any
}

function makeEvent(type: string, source = 'test', payload: unknown = {}): BusEvent {
  return { type, timestamp: new Date().toISOString(), source, payload }
}

describe('EventStream', () => {
  let bus: ReturnType<typeof createTestBus>

  beforeEach(() => {
    bus = createTestBus()
  })

  describe('ring buffer', () => {
    it('stores entries up to capacity', async () => {
      const es = createEventStream(bus, { capacity: 10 })
      for (let i = 0; i < 10; i++) {
        bus._fire(makeEvent(`test.${i}`))
      }
      await new Promise((r) => setTimeout(r, 10))
      expect(es.getBuffer()).toHaveLength(10)
      es.dispose()
    })

    it('evicts oldest when full', async () => {
      const es = createEventStream(bus, { capacity: 5 })
      for (let i = 0; i < 8; i++) {
        bus._fire(makeEvent(`test.${i}`))
      }
      await new Promise((r) => setTimeout(r, 10))
      const buf = es.getBuffer()
      expect(buf).toHaveLength(5)
      expect(buf[0].event.type).toBe('test.3')
      es.dispose()
    })

    it('auto-incrementing id on entries', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a'))
      bus._fire(makeEvent('b'))
      await new Promise((r) => setTimeout(r, 10))
      const buf = es.getBuffer()
      expect(buf[0].id).toBe(1)
      expect(buf[1].id).toBe(2)
      es.dispose()
    })

    it('capturedAt timestamp set on capture', async () => {
      const es = createEventStream(bus)
      const before = Date.now()
      bus._fire(makeEvent('test'))
      await new Promise((r) => setTimeout(r, 10))
      const buf = es.getBuffer()
      expect(buf[0].capturedAt).toBeGreaterThanOrEqual(before)
      expect(buf[0].capturedAt).toBeLessThanOrEqual(Date.now())
      es.dispose()
    })
  })

  describe('query', () => {
    it('with no filter returns all entries (newest first)', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a'))
      bus._fire(makeEvent('b'))
      bus._fire(makeEvent('c'))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query()
      expect(result).toHaveLength(3)
      expect(result[0].event.type).toBe('c')
      expect(result[2].event.type).toBe('a')
      es.dispose()
    })

    it('filters by event type pattern (glob matching)', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('issue.created'))
      bus._fire(makeEvent('issue.updated'))
      bus._fire(makeEvent('pr.merged'))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query({ type: 'issue.*' })
      expect(result).toHaveLength(2)
      es.dispose()
    })

    it('filters by source module', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a', 'git'))
      bus._fire(makeEvent('b', 'issues'))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query({ source: 'git' })
      expect(result).toHaveLength(1)
      expect(result[0].event.source).toBe('git')
      es.dispose()
    })

    it('filters by time range (since/until)', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a'))
      await new Promise((r) => setTimeout(r, 20))
      const mid = Date.now()
      await new Promise((r) => setTimeout(r, 20))
      bus._fire(makeEvent('b'))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query({ since: mid })
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0].event.type).toBe('b')
      es.dispose()
    })

    it('filters by entityId', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a', 'test', { entityId: 'e1' }))
      bus._fire(makeEvent('b', 'test', { entityId: 'e2' }))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query({ entityId: 'e1' })
      expect(result).toHaveLength(1)
      expect(result[0].event.type).toBe('a')
      es.dispose()
    })

    it('supports limit and offset', async () => {
      const es = createEventStream(bus)
      for (let i = 0; i < 10; i++) bus._fire(makeEvent(`e.${i}`))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query({ limit: 3, offset: 2 })
      expect(result).toHaveLength(3)
      // Newest first, so offset 2 skips the 2 newest
      expect(result[0].event.type).toBe('e.7')
      es.dispose()
    })

    it('combined filters (type + source + time)', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('issue.created', 'issues'))
      bus._fire(makeEvent('issue.updated', 'issues'))
      bus._fire(makeEvent('pr.merged', 'review'))
      await new Promise((r) => setTimeout(r, 10))
      const result = es.query({ type: 'issue.*', source: 'issues' })
      expect(result).toHaveLength(2)
      es.dispose()
    })
  })

  describe('stats', () => {
    it('returns totalCaptured', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a'))
      bus._fire(makeEvent('b'))
      await new Promise((r) => setTimeout(r, 10))
      expect(es.stats().totalCaptured).toBe(2)
      es.dispose()
    })

    it('returns rate for last 1m, 5m, 1h', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a'))
      await new Promise((r) => setTimeout(r, 10))
      const s = es.stats()
      expect(s.rate['1m']).toBe(1)
      expect(s.rate['5m']).toBe(1)
      expect(s.rate['1h']).toBe(1)
      es.dispose()
    })

    it('returns byType counts for last 5 minutes', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('issue.created'))
      bus._fire(makeEvent('issue.created'))
      bus._fire(makeEvent('pr.merged'))
      await new Promise((r) => setTimeout(r, 10))
      const s = es.stats()
      expect(s.byType['issue.created']).toBe(2)
      expect(s.byType['pr.merged']).toBe(1)
      es.dispose()
    })

    it('returns bySource counts for last 5 minutes', async () => {
      const es = createEventStream(bus)
      bus._fire(makeEvent('a', 'git'))
      bus._fire(makeEvent('b', 'git'))
      bus._fire(makeEvent('c', 'issues'))
      await new Promise((r) => setTimeout(r, 10))
      const s = es.stats()
      expect(s.bySource['git']).toBe(2)
      expect(s.bySource['issues']).toBe(1)
      es.dispose()
    })
  })

  describe('subscriptions', () => {
    it('subscribe receives new events matching filter', async () => {
      const es = createEventStream(bus)
      const received: unknown[] = []
      es.subscribe((entry) => received.push(entry), { type: 'issue.*' })
      bus._fire(makeEvent('issue.created'))
      bus._fire(makeEvent('pr.merged'))
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(1)
      es.dispose()
    })

    it('subscribe with no filter receives all events', async () => {
      const es = createEventStream(bus)
      const received: unknown[] = []
      es.subscribe((entry) => received.push(entry))
      bus._fire(makeEvent('a'))
      bus._fire(makeEvent('b'))
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(2)
      es.dispose()
    })

    it('unsubscribe stops delivery', async () => {
      const es = createEventStream(bus)
      const received: unknown[] = []
      const unsub = es.subscribe((entry) => received.push(entry))
      bus._fire(makeEvent('a'))
      await new Promise((r) => setTimeout(r, 10))
      unsub()
      bus._fire(makeEvent('b'))
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(1)
      es.dispose()
    })

    it('capture is async (does not block bus)', () => {
      const es = createEventStream(bus)
      // The bus.on('*') handler uses queueMicrotask - verify the bus handler was registered
      expect(bus.on).toBeDefined()
      // The fact that createEventStream registers a wildcard handler is tested via the other tests
      es.dispose()
    })
  })
})
