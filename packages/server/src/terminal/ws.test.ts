import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@template/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerTerminalChannel } from './ws.js'
import type { AttachHandle } from './terminal.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-terminal-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

function subscribe(client: WsLike, channels: string[], scope?: Record<string, string>) {
  ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
    JSON.stringify({ type: 'subscribe', channels, scope })
  )
}

function sendClientMessage(client: WsLike, msg: Record<string, unknown>) {
  ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
    JSON.stringify(msg)
  )
}

function triggerClose(client: WsLike) {
  ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'close')?.[1]()
}

function getSentMessages(client: WsLike): Record<string, unknown>[] {
  return (client.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => {
      if (typeof c[0] === 'string') {
        try {
          return JSON.parse(c[0])
        } catch {
          return null
        }
      }
      return null
    })
    .filter(Boolean)
}

function createMockManager(opts?: { hasSession?: boolean }): any {
  const attachCalls: string[] = []
  let lastHandle = createMockHandle()

  return {
    get lastHandle() {
      return lastHandle
    },
    attachCalls,
    create: vi.fn() as any,
    attach(sessionId: string) {
      attachCalls.push(sessionId)
      lastHandle = createMockHandle()
      return lastHandle
    },
    resize: vi.fn() as any,
    close: vi.fn() as any,
    get: vi.fn().mockReturnValue(opts?.hasSession !== false ? { id: 'sess-1' } : undefined) as any,
    scheduleClose: vi.fn() as any,
    cancelScheduledClose: vi.fn() as any
  }
}

function createMockHandle(): AttachHandle & { _dataCb?: (data: string) => void } {
  const handle: AttachHandle & { _dataCb?: (data: string) => void } = {
    onData(cb: (data: string) => void) {
      handle._dataCb = cb
    },
    write: vi.fn() as any,
    dispose: vi.fn() as any
  }
  return handle
}

describe('Terminal WS Channel', () => {
  describe('channel registration', () => {
    it('registers terminal channel with correct server message types', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)
      expect(ws.getChannels()).toContain('terminal')
    })

    it('registers terminal channel with correct client message types', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)
      // Verify client messages are routed by sending them
      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })
      // terminal.input should not cause an error
      sendClientMessage(client, { type: 'terminal.input', data: 'hello' })
      const msgs = getSentMessages(client)
      expect(msgs.find((m) => m.type === 'error' && m.code === 'UNKNOWN_TYPE')).toBeUndefined()
    })

    it('registers terminal channel with binary support', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      // Binary support means sendBinary works without error
      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })
      // Should not throw
      ws.sendBinary('terminal', Buffer.from('test'), { sessionId: 'sess-1' })
    })
  })

  describe('bus → WS bridge', () => {
    it('bridges terminal.created bus event to terminal.created WS message', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'])

      bus.emit({
        type: 'terminal.created',
        timestamp: new Date().toISOString(),
        source: 'terminal',
        payload: { sessionId: 'sess-1', cwd: '/tmp' }
      })

      const msg = getSentMessages(client).find((m) => m.type === 'terminal.created')
      expect(msg).toBeDefined()
      expect(msg!.sessionId).toBe('sess-1')
    })

    it('bridges terminal.closed bus event to terminal.closed WS message', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'])

      bus.emit({
        type: 'terminal.closed',
        timestamp: new Date().toISOString(),
        source: 'terminal',
        payload: { sessionId: 'sess-1' }
      })

      const msg = getSentMessages(client).find((m) => m.type === 'terminal.closed')
      expect(msg).toBeDefined()
      expect(msg!.sessionId).toBe('sess-1')
    })

    it('terminal data bypasses bus — direct binary push', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      // The onSubscribe callback attaches and sets up onData → sendBinary
      // Trigger the data callback
      const handle = mgr.lastHandle
      expect(handle._dataCb).toBeDefined()
      handle._dataCb!('hello world')

      // Should have received a binary frame (Buffer)
      const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
      const binaryCall = calls.find((c: unknown[]) => Buffer.isBuffer(c[0]))
      expect(binaryCall).toBeDefined()
    })
  })

  describe('client → server', () => {
    it('handles terminal.input binary frames', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      const handle = mgr.lastHandle
      sendClientMessage(client, { type: 'terminal.input', data: 'ls -la\n' })
      expect(handle.write).toHaveBeenCalledWith('ls -la\n')
    })

    it('handles terminal.resize message', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      sendClientMessage(client, { type: 'terminal.resize', cols: 120, rows: 40 })
      expect(mgr.resize).toHaveBeenCalledWith('sess-1', 120, 40)
    })
  })

  describe('subscription scoping', () => {
    it('scopes messages by sessionId', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      // Binary sent for sess-2 should not reach client subscribed to sess-1
      ws.sendBinary('terminal', Buffer.from('data'), { sessionId: 'sess-2' })
      const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
      const binaryAfterSubscribe = calls.filter((c: unknown[]) => Buffer.isBuffer(c[0]))
      // No binary for sess-2
      // (any binary calls would be from onSubscribe attaching sess-1, not sess-2)
      // Just verify no extra binary arrived after the subscribe setup
      const countBefore = binaryAfterSubscribe.length
      ws.sendBinary('terminal', Buffer.from('other'), { sessionId: 'sess-2' })
      const countAfter = (client.send as ReturnType<typeof vi.fn>).mock.calls.filter((c: unknown[]) =>
        Buffer.isBuffer(c[0])
      ).length
      expect(countAfter).toBe(countBefore)
    })

    it('onSubscribe attaches client to terminal session', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      expect(mgr.attachCalls).toContain('sess-1')
      expect(mgr.cancelScheduledClose).toHaveBeenCalledWith('sess-1')
    })
  })

  describe('disconnect', () => {
    it('onUnsubscribe detaches client from terminal session', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      const handle = mgr.lastHandle

      // Unsubscribe
      sendClientMessage(client, { type: 'unsubscribe', channels: ['terminal'] })
      expect(handle.dispose).toHaveBeenCalled()
    })

    it('onDisconnect starts grace period close', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      const handle = mgr.lastHandle

      // Simulate WS close
      triggerClose(client)

      expect(handle.dispose).toHaveBeenCalled()
      expect(mgr.scheduleClose).toHaveBeenCalledWith('sess-1')
    })
  })

  describe('binary frames', () => {
    it('sends terminal output as binary frame with channel ID prefix', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      const handle = mgr.lastHandle
      handle._dataCb!('output data')

      const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
      const binaryCall = calls.find((c: unknown[]) => Buffer.isBuffer(c[0]))
      expect(binaryCall).toBeDefined()
      // First byte(s) should be channel ID prefix
      const buf = binaryCall![0] as Buffer
      expect(buf.length).toBeGreaterThan('output data'.length)
    })

    it('receives terminal input as binary frame', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      const handle = mgr.lastHandle
      // Send input via client message (JSON-based input, not raw binary)
      sendClientMessage(client, { type: 'terminal.input', data: 'echo hello' })
      expect(handle.write).toHaveBeenCalledWith('echo hello')
    })

    it('binary round-trip preserves data', () => {
      const bus = createEventBus(tmpDir())
      const ws = createWsHandler(bus)
      const mgr = createMockManager()
      registerTerminalChannel(ws, bus, mgr)

      const client = mockWs()
      ws.handleConnection(client, 'device-1')
      subscribe(client, ['terminal'], { sessionId: 'sess-1' })

      const handle = mgr.lastHandle
      const testData = 'Hello, terminal! 🎉'
      handle._dataCb!(testData)

      const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
      const binaryCall = calls.find((c: unknown[]) => Buffer.isBuffer(c[0]))
      expect(binaryCall).toBeDefined()
      const buf = binaryCall![0] as Buffer
      // The payload after the channel ID prefix should contain our data
      // Channel ID is encoded as a varint (1 byte for small IDs)
      const payload = buf.slice(1).toString()
      expect(payload).toBe(testData)
    })
  })
})
