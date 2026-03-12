import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWsStore } from './ws-store.js'

let instances: any[] = []

function createMockWebSocket(url: string) {
  const ws = {
    url,
    readyState: 0,
    onopen: null as ((ev: unknown) => void) | null,
    onclose: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: string }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    sent: [] as string[],
    send(data: string) {
      ws.sent.push(data)
    },
    close() {
      ws.readyState = 3
      ws.onclose?.({})
    },
    open() {
      ws.readyState = 1
      ws.onopen?.({})
    },
    receiveMessage(msg: unknown) {
      ws.onmessage?.({ data: JSON.stringify(msg) })
    }
  }
  instances.push(ws)
  return ws
}

function MockWsCtor(url: string) {
  return createMockWebSocket(url)
}

beforeEach(() => {
  instances = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function lastWs() {
  return instances[instances.length - 1]
}

describe('WsStore', () => {
  describe('connection state', () => {
    it('starts as disconnected', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      expect(store.connected()).toBe(false)
      store.close()
    })

    it('connected returns true when WebSocket is open', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      expect(store.connected()).toBe(true)
      store.close()
    })

    it('connected returns false when WebSocket closes', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      expect(store.connected()).toBe(true)
      lastWs().close()
      expect(store.connected()).toBe(false)
      store.close()
    })
  })

  describe('subscribe/unsubscribe', () => {
    it('sends subscribe message to server', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      store.subscribe(['files'], { projectId: 'p1' })
      const msg = JSON.parse(lastWs().sent[lastWs().sent.length - 1])
      expect(msg.type).toBe('subscribe')
      expect(msg.channels).toEqual(['files'])
      store.close()
    })

    it('sends unsubscribe message to server', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      store.subscribe(['files'])
      store.unsubscribe(['files'])
      const msg = JSON.parse(lastWs().sent[lastWs().sent.length - 1])
      expect(msg.type).toBe('unsubscribe')
      store.close()
    })

    it('re-subscribes to all active channels on reconnect', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      const firstWs = lastWs()
      firstWs.open()
      store.subscribe(['files'])
      store.subscribe(['status'])
      firstWs.close()
      vi.advanceTimersByTime(2000)
      const secondWs = lastWs()
      expect(secondWs).not.toBe(firstWs)
      secondWs.open()
      const subscribeMsgs = secondWs.sent.filter((s: string) => JSON.parse(s).type === 'subscribe')
      expect(subscribeMsgs.length).toBe(2)
      store.close()
    })
  })

  describe('message handling', () => {
    it('on registers handler for message type', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      const handler = vi.fn()
      store.on('status.update', handler)
      lastWs().receiveMessage({ type: 'status.update', data: 'hi' })
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'status.update' }))
      store.close()
    })

    it('on returns unsubscribe function', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      const handler = vi.fn()
      const unsub = store.on('test', handler)
      unsub()
      lastWs().receiveMessage({ type: 'test' })
      expect(handler).not.toHaveBeenCalled()
      store.close()
    })

    it('dispatches incoming message to registered handlers', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      const h1 = vi.fn()
      const h2 = vi.fn()
      store.on('x', h1)
      store.on('x', h2)
      lastWs().receiveMessage({ type: 'x' })
      expect(h1).toHaveBeenCalled()
      expect(h2).toHaveBeenCalled()
      store.close()
    })

    it('does not dispatch to removed handlers', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      const h = vi.fn()
      const unsub = store.on('x', h)
      unsub()
      lastWs().receiveMessage({ type: 'x' })
      expect(h).not.toHaveBeenCalled()
      store.close()
    })
  })

  describe('send', () => {
    it('sends message through WebSocket', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      lastWs().open()
      store.send({ type: 'custom' })
      const msg = JSON.parse(lastWs().sent[lastWs().sent.length - 1])
      expect(msg.type).toBe('custom')
      store.close()
    })

    it('queues message if not connected', () => {
      const store = createWsStore({ url: 'ws://localhost', WebSocket: MockWsCtor as any })
      store.send({ type: 'queued' })
      expect(lastWs().sent).toHaveLength(0)
      lastWs().open()
      expect(lastWs().sent.some((s: string) => JSON.parse(s).type === 'queued')).toBe(true)
      store.close()
    })
  })
})
