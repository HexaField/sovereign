import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createEventStream, type EventStream } from './event-stream.js'
import type { EventBus, BusEvent, BusHandler } from '@sovereign/core'
import type { WsHandler, WsLike } from '../ws/handler.js'

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

function createMockWsHandler(): WsHandler & {
  _channels: Map<string, any>
  _sent: Array<{ deviceId: string; msg: any }>
  _broadcast: Array<{ channel: string; msg: any }>
} {
  const channels = new Map<string, any>()
  const sent: Array<{ deviceId: string; msg: any }> = []
  const broadcast: Array<{ channel: string; msg: any }> = []
  return {
    _channels: channels,
    _sent: sent,
    _broadcast: broadcast,
    registerChannel(name: string, options: any) {
      channels.set(name, options)
    },
    handleConnection(_ws: WsLike, _deviceId: string) {},
    broadcast: vi.fn(),
    broadcastToChannel(channel: string, msg: any) {
      broadcast.push({ channel, msg })
    },
    sendTo(deviceId: string, msg: any) {
      sent.push({ deviceId, msg })
    },
    sendBinary() {},
    getConnectedDevices() {
      return []
    },
    getChannels() {
      return [...channels.keys()]
    }
  }
}

function makeEvent(type: string): BusEvent {
  return { type, timestamp: new Date().toISOString(), source: 'test', payload: {} }
}

describe('Event Stream WS', () => {
  let bus: ReturnType<typeof createTestBus>
  let es: EventStream
  let wsHandler: ReturnType<typeof createMockWsHandler>

  beforeEach(() => {
    bus = createTestBus()
    es = createEventStream(bus)
    wsHandler = createMockWsHandler()

    // Register events channel (mimics what index.ts does)
    wsHandler.registerChannel('events', {
      serverMessages: ['event.new', 'event.history'],
      clientMessages: [],
      onSubscribe: (deviceId: string) => {
        const recent = es.query({ limit: 100 })
        wsHandler.sendTo(deviceId, {
          type: 'event.history',
          events: recent,
          timestamp: new Date().toISOString()
        })
      }
    })
    es.subscribe((entry) => {
      wsHandler.broadcastToChannel('events', {
        type: 'event.new',
        ...entry,
        timestamp: new Date().toISOString()
      })
    })
  })

  afterEach(() => {
    es.dispose()
  })

  it('events channel registered with WS handler', () => {
    expect(wsHandler._channels.has('events')).toBe(true)
  })

  it('new events broadcast to subscribers', async () => {
    bus._fire(makeEvent('test.event'))
    await new Promise((r) => setTimeout(r, 10))
    expect(wsHandler._broadcast.length).toBeGreaterThanOrEqual(1)
    expect(wsHandler._broadcast[0].channel).toBe('events')
    expect(wsHandler._broadcast[0].msg.type).toBe('event.new')
  })

  it('scoped subscription only receives matching events', async () => {
    const received: unknown[] = []
    es.subscribe((entry) => received.push(entry), { type: 'issue.*' })
    bus._fire(makeEvent('issue.created'))
    bus._fire(makeEvent('pr.merged'))
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(1)
  })

  it('unscoped subscription receives all events', async () => {
    const received: unknown[] = []
    es.subscribe((entry) => received.push(entry))
    bus._fire(makeEvent('a'))
    bus._fire(makeEvent('b'))
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toHaveLength(2)
  })

  it('history sent on subscribe', async () => {
    bus._fire(makeEvent('test.event'))
    await new Promise((r) => setTimeout(r, 10))
    const opts = wsHandler._channels.get('events')
    opts.onSubscribe('device-1')
    expect(wsHandler._sent.length).toBeGreaterThanOrEqual(1)
    expect(wsHandler._sent[0].msg.type).toBe('event.history')
    expect(wsHandler._sent[0].msg.events.length).toBeGreaterThanOrEqual(1)
  })
})
