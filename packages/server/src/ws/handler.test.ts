import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { createWsHandler } from './handler.js'
import type { WsLike } from './handler.js'
import type { EventBus, BusEvent } from '@template/core'

function mockBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = []
  return {
    events,
    emit: (e: BusEvent) => {
      events.push(e)
    },
    on: () => () => {},
    once: () => () => {},
    replay: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    history: () => []
  }
}

function mockWs(): WsLike & EventEmitter & { sent: unknown[] } {
  const ee = new EventEmitter() as EventEmitter & WsLike & { sent: unknown[] }
  ee.sent = []
  ee.send = (data: string | Buffer) => {
    ee.sent.push(data)
  }
  ee.close = () => {}
  return ee
}

function lastSent(ws: ReturnType<typeof mockWs>): unknown {
  return JSON.parse(ws.sent[ws.sent.length - 1] as string)
}

describe('WsHandler', () => {
  describe('channel registration', () => {
    it('registers a channel with server and client message types', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('files', { serverMessages: ['file.changed'], clientMessages: ['file.watch'] })
      expect(handler.getChannels()).toContain('files')
    })

    it('rejects duplicate channel registration', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('files', { serverMessages: [], clientMessages: [] })
      expect(() => handler.registerChannel('files', { serverMessages: [], clientMessages: [] })).toThrow()
    })

    it('lists registered channels', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('a', { serverMessages: [], clientMessages: [] })
      handler.registerChannel('b', { serverMessages: [], clientMessages: [] })
      expect(handler.getChannels()).toEqual(['a', 'b'])
    })
  })

  describe('connection', () => {
    it('emits ws.connected on bus with device ID', () => {
      const bus = mockBus()
      const handler = createWsHandler(bus)
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'device-1')
      expect(
        bus.events.some((e) => e.type === 'ws.connected' && (e.payload as { deviceId: string }).deviceId === 'device-1')
      ).toBe(true)
    })
  })

  describe('subscribe/unsubscribe', () => {
    it('subscribes client to registered channel', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: ['status.update'], clientMessages: [] })
      handler.registerChannel('files', { serverMessages: ['file.changed'], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'subscribe', channels: ['files'] }))
      // broadcastToChannel should reach d1 for files
      handler.broadcastToChannel('files', { type: 'file.changed' })
      // Last sent should be the file.changed message
      expect(ws.sent.some((s) => JSON.parse(s as string).type === 'file.changed')).toBe(true)
    })

    it('rejects subscribe to unregistered channel', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'subscribe', channels: ['nonexistent'] }))
      expect(lastSent(ws)).toEqual(expect.objectContaining({ type: 'error', code: 'UNKNOWN_CHANNEL' }))
    })

    it('unsubscribes client from channel', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: ['status.update'], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'unsubscribe', channels: ['status'] }))
      ws.sent = []
      handler.broadcastToChannel('status', { type: 'status.update' })
      expect(ws.sent).toHaveLength(0)
    })

    it('default subscription includes status channel', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: ['status.update'], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      handler.broadcastToChannel('status', { type: 'status.update' })
      expect(ws.sent.some((s) => JSON.parse(s as string).type === 'status.update')).toBe(true)
    })
  })

  describe('message routing', () => {
    it('routes message only to subscribed clients', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      handler.registerChannel('files', { serverMessages: ['file.changed'], clientMessages: [] })
      const ws1 = mockWs()
      const ws2 = mockWs()
      handler.handleConnection(ws1, 'd1')
      handler.handleConnection(ws2, 'd2')
      ws1.emit('message', JSON.stringify({ type: 'subscribe', channels: ['files'] }))
      ws1.sent = []
      ws2.sent = []
      handler.broadcastToChannel('files', { type: 'file.changed' })
      expect(ws1.sent).toHaveLength(1)
      expect(ws2.sent).toHaveLength(0)
    })

    it('scopes messages by orgId', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      handler.registerChannel('files', { serverMessages: ['file.changed'], clientMessages: [] })
      const ws1 = mockWs()
      const ws2 = mockWs()
      handler.handleConnection(ws1, 'd1')
      handler.handleConnection(ws2, 'd2')
      ws1.emit('message', JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { orgId: 'org1' } }))
      ws2.emit('message', JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { orgId: 'org2' } }))
      ws1.sent = []
      ws2.sent = []
      handler.broadcastToChannel('files', { type: 'file.changed' }, { orgId: 'org1' })
      expect(ws1.sent).toHaveLength(1)
      expect(ws2.sent).toHaveLength(0)
    })

    it('scopes messages by projectId', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      handler.registerChannel('files', { serverMessages: ['f'], clientMessages: [] })
      const ws1 = mockWs()
      handler.handleConnection(ws1, 'd1')
      ws1.emit('message', JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { projectId: 'p1' } }))
      ws1.sent = []
      handler.broadcastToChannel('files', { type: 'f' }, { projectId: 'p2' })
      expect(ws1.sent).toHaveLength(0)
    })

    it('scopes messages by sessionId', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      handler.registerChannel('term', { serverMessages: ['t'], clientMessages: [] })
      const ws1 = mockWs()
      handler.handleConnection(ws1, 'd1')
      ws1.emit('message', JSON.stringify({ type: 'subscribe', channels: ['term'], scope: { sessionId: 's1' } }))
      ws1.sent = []
      handler.broadcastToChannel('term', { type: 't' }, { sessionId: 's1' })
      expect(ws1.sent).toHaveLength(1)
    })
  })

  describe('built-in messages', () => {
    it('responds to ping with pong', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'ping' }))
      expect(lastSent(ws)).toEqual(expect.objectContaining({ type: 'pong' }))
    })

    it('sends error messages with code and message', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', 'not json{{{')
      expect(lastSent(ws)).toEqual(expect.objectContaining({ type: 'error', code: 'PARSE_ERROR' }))
    })

    it('sends ack for messages with ackId', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: ['do.thing'] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'do.thing', ackId: 'abc123' }))
      expect(
        ws.sent.some((s) => {
          const m = JSON.parse(s as string)
          return m.type === 'ack' && m.ackId === 'abc123'
        })
      ).toBe(true)
    })
  })

  describe('client message validation', () => {
    it('rejects client message with unregistered type', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'unknown.type' }))
      expect(lastSent(ws)).toEqual(expect.objectContaining({ type: 'error', code: 'UNKNOWN_TYPE' }))
    })

    it('routes valid client message to channel onMessage handler', () => {
      const onMessage = vi.fn()
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: ['status.request'], onMessage })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('message', JSON.stringify({ type: 'status.request', data: 'hi' }))
      expect(onMessage).toHaveBeenCalledWith(
        'status.request',
        expect.objectContaining({ type: 'status.request' }),
        'd1'
      )
    })
  })

  describe('disconnect', () => {
    it('cleans up subscriptions on disconnect', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('close')
      expect(handler.getConnectedDevices()).not.toContain('d1')
    })

    it('invokes channel onDisconnect callbacks', () => {
      const onDisconnect = vi.fn()
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [], onDisconnect })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('close')
      expect(onDisconnect).toHaveBeenCalledWith('d1')
    })

    it('emits ws.disconnected on bus with device ID', () => {
      const bus = mockBus()
      const handler = createWsHandler(bus)
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws = mockWs()
      handler.handleConnection(ws, 'd1')
      ws.emit('close')
      expect(
        bus.events.some((e) => e.type === 'ws.disconnected' && (e.payload as { deviceId: string }).deviceId === 'd1')
      ).toBe(true)
    })
  })

  describe('broadcast', () => {
    it('broadcasts message to all connected clients', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws1 = mockWs()
      const ws2 = mockWs()
      handler.handleConnection(ws1, 'd1')
      handler.handleConnection(ws2, 'd2')
      handler.broadcast({ type: 'announcement' })
      expect(ws1.sent).toHaveLength(1)
      expect(ws2.sent).toHaveLength(1)
    })

    it('broadcastToChannel sends only to channel subscribers', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: ['s'], clientMessages: [] })
      handler.registerChannel('files', { serverMessages: ['f'], clientMessages: [] })
      const ws1 = mockWs()
      const ws2 = mockWs()
      handler.handleConnection(ws1, 'd1')
      handler.handleConnection(ws2, 'd2')
      ws1.emit('message', JSON.stringify({ type: 'subscribe', channels: ['files'] }))
      ws1.sent = []
      ws2.sent = []
      handler.broadcastToChannel('files', { type: 'f' })
      expect(ws1.sent).toHaveLength(1)
      expect(ws2.sent).toHaveLength(0)
    })

    it('sendTo sends to specific device', () => {
      const handler = createWsHandler(mockBus())
      handler.registerChannel('status', { serverMessages: [], clientMessages: [] })
      const ws1 = mockWs()
      const ws2 = mockWs()
      handler.handleConnection(ws1, 'd1')
      handler.handleConnection(ws2, 'd2')
      handler.sendTo('d1', { type: 'hello' })
      expect(ws1.sent).toHaveLength(1)
      expect(ws2.sent).toHaveLength(0)
    })
  })
})
