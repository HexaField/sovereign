import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createEventBus } from './bus.js'
import { createEventLogger } from './logger.js'
import type { BusEvent, EventBus } from './types.js'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const makeEvent = (type: string, payload: unknown = {}): BusEvent => ({
  type,
  timestamp: new Date().toISOString(),
  source: 'test',
  payload
})

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('EventBus', () => {
  let bus: EventBus
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sovereign-bus-test-'))
    bus = createEventBus(dataDir)
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('emits events to synchronous subscribers', () => {
    const received: BusEvent[] = []
    bus.on('test.event', (e) => {
      received.push(e)
    })
    const ev = makeEvent('test.event', { foo: 1 })
    bus.emit(ev)
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(ev)
  })

  it('emits events to asynchronous subscribers', async () => {
    const received: BusEvent[] = []
    bus.on('test.async', async (e) => {
      await delay(10)
      received.push(e)
    })
    bus.emit(makeEvent('test.async'))
    // async handler queued, wait for it
    await delay(50)
    expect(received).toHaveLength(1)
  })

  it('requires type, timestamp, and source on every event', () => {
    const received: BusEvent[] = []
    bus.on('*', (e) => {
      received.push(e)
    })
    const ev: BusEvent = { type: 'a', timestamp: '2026-01-01T00:00:00Z', source: 'src', payload: null }
    bus.emit(ev)
    expect(received[0].type).toBe('a')
    expect(received[0].timestamp).toBe('2026-01-01T00:00:00Z')
    expect(received[0].source).toBe('src')
  })

  it('supports wildcard subscriptions with *', () => {
    const received: BusEvent[] = []
    bus.on('*', (e) => {
      received.push(e)
    })
    bus.emit(makeEvent('anything'))
    bus.emit(makeEvent('something.else'))
    expect(received).toHaveLength(2)
  })

  it('supports prefix wildcard subscriptions (e.g. scheduler.*)', () => {
    const received: BusEvent[] = []
    bus.on('scheduler.*', (e) => {
      received.push(e)
    })
    bus.emit(makeEvent('scheduler.job.due'))
    bus.emit(makeEvent('scheduler.tick'))
    bus.emit(makeEvent('other.event'))
    expect(received).toHaveLength(2)
  })

  it('provides correctly typed payloads to subscribers', () => {
    const received: BusEvent[] = []
    bus.on('typed', (e) => {
      received.push(e)
    })
    bus.emit(makeEvent('typed', { count: 42 }))
    expect((received[0].payload as { count: number }).count).toBe(42)
  })

  it('logs every emitted event to disk', () => {
    bus.emit(makeEvent('log.test', { a: 1 }))
    bus.emit(makeEvent('log.test2', { b: 2 }))
    const eventsDir = join(dataDir, 'events')
    const files = readdirSync(eventsDir)
    expect(files.length).toBeGreaterThan(0)
    const content = readFileSync(join(eventsDir, files[0]), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('replays historical events from the log with filter', async () => {
    bus.emit(makeEvent('replay.a'))
    bus.emit(makeEvent('replay.b'))
    bus.emit(makeEvent('other'))

    const events: BusEvent[] = []
    for await (const e of bus.replay({ pattern: 'replay.*' })) {
      events.push(e)
    }
    expect(events).toHaveLength(2)
  })

  it('catches subscriber errors and emits bus.error events', async () => {
    const errors: BusEvent[] = []
    bus.on('bus.error', (e) => {
      errors.push(e)
    })
    bus.on('bad', () => {
      throw new Error('boom')
    })
    bus.emit(makeEvent('bad'))
    await delay(10)
    expect(errors).toHaveLength(1)
    expect((errors[0].payload as any).error).toBe('boom')
  })

  it('does not swallow subscriber errors silently', async () => {
    const errors: BusEvent[] = []
    bus.on('bus.error', (e) => {
      errors.push(e)
    })
    bus.on('fail', () => {
      throw new Error('silent?')
    })
    bus.emit(makeEvent('fail'))
    await delay(10)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('queues events for slow subscribers instead of dropping them', async () => {
    const received: BusEvent[] = []
    bus.on('slow', async (e) => {
      await delay(50)
      received.push(e)
    })
    bus.emit(makeEvent('slow', { i: 1 }))
    bus.emit(makeEvent('slow', { i: 2 }))
    bus.emit(makeEvent('slow', { i: 3 }))
    await delay(300)
    expect(received).toHaveLength(3)
    expect((received[0].payload as any).i).toBe(1)
    expect((received[2].payload as any).i).toBe(3)
  })

  it('returns recent events from history with pattern filter', () => {
    bus.emit(makeEvent('hist.a'))
    bus.emit(makeEvent('hist.b'))
    bus.emit(makeEvent('other'))
    const results = bus.history({ pattern: 'hist.*' })
    expect(results).toHaveLength(2)
  })

  it('returns recent events from history with limit', () => {
    for (let i = 0; i < 10; i++) bus.emit(makeEvent('h', { i }))
    const results = bus.history({ limit: 3 })
    expect(results).toHaveLength(3)
    expect((results[0].payload as any).i).toBe(7)
  })

  it('once handler fires only once', () => {
    const received: BusEvent[] = []
    bus.once('once.test', (e) => {
      received.push(e)
    })
    bus.emit(makeEvent('once.test'))
    bus.emit(makeEvent('once.test'))
    expect(received).toHaveLength(1)
  })

  it('unsubscribe stops further event delivery', () => {
    const received: BusEvent[] = []
    const unsub = bus.on('unsub.test', (e) => {
      received.push(e)
    })
    bus.emit(makeEvent('unsub.test'))
    unsub()
    bus.emit(makeEvent('unsub.test'))
    expect(received).toHaveLength(1)
  })
})

describe('EventLogger', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'sovereign-logger-test-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('writes events to YYYY-MM-DD.jsonl files', () => {
    const logger = createEventLogger(dataDir)
    const ev = makeEvent('test')
    logger.log(ev)
    const files = readdirSync(join(dataDir, 'events'))
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  it('reads events back from log files', async () => {
    const logger = createEventLogger(dataDir)
    logger.log(makeEvent('read.back'))
    logger.log(makeEvent('read.back2'))
    const events: BusEvent[] = []
    for await (const e of logger.read({})) events.push(e)
    expect(events).toHaveLength(2)
  })

  it('filters events by pattern during read', async () => {
    const logger = createEventLogger(dataDir)
    logger.log(makeEvent('foo.bar'))
    logger.log(makeEvent('baz'))
    const events: BusEvent[] = []
    for await (const e of logger.read({ pattern: 'foo.*' })) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('foo.bar')
  })

  it('filters events by date range during read', async () => {
    const logger = createEventLogger(dataDir)
    const early: BusEvent = { type: 'a', timestamp: '2026-01-01T00:00:00Z', source: 'test', payload: {} }
    const late: BusEvent = { type: 'b', timestamp: '2026-12-01T00:00:00Z', source: 'test', payload: {} }
    logger.log(early)
    logger.log(late)
    const events: BusEvent[] = []
    for await (const e of logger.read({ after: '2026-06-01T00:00:00Z' })) events.push(e)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('b')
  })

  it('creates data directory if it does not exist', () => {
    const newDir = join(dataDir, 'nested', 'deep')
    const logger = createEventLogger(newDir)
    logger.log(makeEvent('test'))
    const files = readdirSync(join(newDir, 'events'))
    expect(files).toHaveLength(1)
  })
})
