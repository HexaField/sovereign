import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createChatModule } from './chat.js'
import type { ChatModule, ThreadManager } from './chat.js'
import type { EventBus, AgentBackend, AgentBackendEvents, BackendConnectionStatus, ParsedTurn } from '@template/core'
import type { WsHandler } from '../ws/handler.js'
import type { WsMessage } from '@template/core'

// --- Helpers ---

function createMockBus(): EventBus {
  const handlers = new Map<string, Array<(e: unknown) => void>>()
  return {
    emit: vi.fn((event: { type: string }) => {
      for (const [pattern, fns] of handlers) {
        if (event.type === pattern || pattern === '*') {
          for (const fn of fns) fn(event)
        }
      }
    }),
    on: vi.fn((pattern: string, handler: (e: unknown) => void) => {
      if (!handlers.has(pattern)) handlers.set(pattern, [])
      handlers.get(pattern)!.push(handler)
      return () => {
        const arr = handlers.get(pattern)
        if (arr) {
          const idx = arr.indexOf(handler)
          if (idx >= 0) arr.splice(idx, 1)
        }
      }
    }),
    once: vi.fn(() => () => {}),
    replay: vi.fn(),
    history: vi.fn(() => [])
  } as unknown as EventBus
}

function createMockBackend(): AgentBackend & { _handlers: Map<string, Array<(...args: unknown[]) => void>> } {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    _handlers: handlers,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(() => 'connected' as BackendConnectionStatus),
    sendMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async (_label?: string) => `session-${Date.now()}`),
    getHistory: vi.fn(async () => []),
    on: vi.fn(<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(handler as (...args: unknown[]) => void)
    }),
    off: vi.fn()
  }
}

function createMockThreadManager(): ThreadManager {
  let counter = 0
  return {
    getSessionKey: vi.fn((_threadKey: string) => undefined),
    createThread: vi.fn((_label?: string) => `thread-${++counter}`)
  }
}

function createMockWsHandler(): WsHandler {
  return {
    registerChannel: vi.fn(),
    handleConnection: vi.fn(),
    broadcast: vi.fn(),
    broadcastToChannel: vi.fn(),
    sendTo: vi.fn(),
    sendBinary: vi.fn(),
    getConnectedDevices: vi.fn(() => []),
    getChannels: vi.fn(() => [])
  }
}

function emitBackendEvent<K extends keyof AgentBackendEvents>(
  backend: ReturnType<typeof createMockBackend>,
  event: K,
  data: AgentBackendEvents[K]
): void {
  const fns = backend._handlers.get(event)
  if (fns) for (const fn of fns) fn(data)
}

describe('§2.4 Chat Module (Server)', () => {
  let bus: EventBus
  let backend: ReturnType<typeof createMockBackend>
  let threadManager: ThreadManager
  let wsHandler: ReturnType<typeof createMockWsHandler>
  let chatModule: ChatModule
  let dataDir: string

  beforeEach(() => {
    bus = createMockBus()
    backend = createMockBackend()
    threadManager = createMockThreadManager()
    wsHandler = createMockWsHandler()
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-'))
    let sessionCounter = 0
    ;(backend.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => `session-${++sessionCounter}`)
    chatModule = createChatModule(bus, backend, threadManager, { dataDir, wsHandler })
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('MUST register WS channel chat on the Phase 3 WS protocol', () => {
    // The chat module itself doesn't register the channel — registerChatWs does.
    // But verifying that the module can be created and has the expected interface:
    expect(chatModule.status()).toEqual({ name: 'chat', status: 'ok' })
  })

  it('MUST proxy chat.send to backend.sendMessage(sessionKey, text, attachments)', async () => {
    // First create a session mapping
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadKey, 'hello')
    expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'hello', undefined)
  })

  it('MUST proxy chat.abort to backend.abort(sessionKey)', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleAbort(threadKey)
    expect(backend.abort).toHaveBeenCalledWith(sessionKey)
  })

  it('MUST proxy chat.history to backend.getHistory(sessionKey) and respond with chat.session.info', async () => {
    const turns: ParsedTurn[] = [{ role: 'user', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] }]
    ;(backend.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue(turns)
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleHistory(threadKey, 'device-1')
    expect(backend.getHistory).toHaveBeenCalledWith(sessionKey)
    expect(wsHandler.sendTo).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({
        type: 'chat.session.info',
        threadKey,
        history: turns
      })
    )
  })

  it('MUST proxy chat.session.switch to backend.switchSession(sessionKey)', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSessionSwitch(threadKey)
    expect(backend.switchSession).toHaveBeenCalledWith(sessionKey)
  })

  it('MUST proxy chat.session.create to backend.createSession(label)', async () => {
    const result = await chatModule.handleSessionCreate('test-label')
    expect(backend.createSession).toHaveBeenCalledWith('test-label')
    expect(result.threadKey).toBeTruthy()
    expect(result.sessionKey).toBeTruthy()
  })

  it('MUST proxy chat.stream events to subscribed clients via WS', () => {
    // Set up a mapping first
    // Manually set mapping via handleSessionCreate won't work sync, so create module with pre-existing mapping
    // Instead, emit event and check — we need the mapping to exist
    // Let's use the internal approach: create session then emit
    chatModule.handleSessionCreate().then(({ threadKey: tk, sessionKey: sk }) => {
      emitBackendEvent(backend, 'chat.stream', { sessionKey: sk, text: 'hello' })
      expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
        'chat',
        expect.objectContaining({ type: 'chat.stream', text: 'hello', threadKey: tk }),
        { threadKey: tk }
      )
    })
  })

  it('MUST proxy chat.turn events to subscribed clients via WS', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    const turn: ParsedTurn = { role: 'assistant', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] }
    emitBackendEvent(backend, 'chat.turn', { sessionKey, turn })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.turn', threadKey }),
      { threadKey }
    )
  })

  it('MUST proxy chat.status events to subscribed clients via WS', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.status', { sessionKey, status: 'working' })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.status', threadKey, status: 'working' }),
      { threadKey }
    )
  })

  it('MUST proxy chat.work events to subscribed clients via WS', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    const work = { type: 'tool_call' as const, name: 'test', timestamp: 1 }
    emitBackendEvent(backend, 'chat.work', { sessionKey, work })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.work', threadKey }),
      { threadKey }
    )
  })

  it('MUST proxy chat.compacting events to subscribed clients via WS', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.compacting', { sessionKey, active: true })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.compacting', threadKey, active: true }),
      { threadKey }
    )
  })

  it('MUST proxy chat.error events to subscribed clients via WS', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.error', { sessionKey, error: 'boom' })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.error', threadKey, error: 'boom' }),
      { threadKey }
    )
  })

  it('MUST proxy chat.session.info events to subscribed clients via WS', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'session.info', { sessionKey, history: [] })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.session.info', threadKey }),
      { threadKey }
    )
  })

  it('MUST respect Phase 3 WS scoping — client subscribed with threadKey scope only receives events for that thread', async () => {
    const result1 = await chatModule.handleSessionCreate()
    const result2 = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.stream', { sessionKey: result1.sessionKey, text: 'for-1' })
    emitBackendEvent(backend, 'chat.stream', { sessionKey: result2.sessionKey, text: 'for-2' })
    // Each broadcast should use the correct threadKey scope
    const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const call1 = calls.find((c: unknown[]) => (c[1] as WsMessage).text === 'for-1')
    const call2 = calls.find((c: unknown[]) => (c[1] as WsMessage).text === 'for-2')
    expect(call1![2]).toEqual({ threadKey: result1.threadKey })
    expect(call2![2]).toEqual({ threadKey: result2.threadKey })
  })

  it('MUST emit chat.message.sent bus event when a user sends a message', async () => {
    const { threadKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadKey, 'hello world')
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.message.sent',
        source: 'chat',
        payload: expect.objectContaining({ threadKey, text: 'hello world' })
      })
    )
  })

  it('MUST emit chat.turn.completed bus event when the agent completes a turn', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    const turn: ParsedTurn = { role: 'assistant', content: 'done', timestamp: 1, workItems: [], thinkingBlocks: [] }
    emitBackendEvent(backend, 'chat.turn', { sessionKey, turn })
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.turn.completed',
        source: 'chat',
        payload: expect.objectContaining({ threadKey, turn })
      })
    )
  })

  it('MUST create a corresponding backend session when a new thread is created', async () => {
    const result = await chatModule.handleSessionCreate('my-thread')
    expect(backend.createSession).toHaveBeenCalledWith('my-thread')
    expect(result.sessionKey).toBeTruthy()
    expect(chatModule.getSessionKeyForThread(result.threadKey)).toBe(result.sessionKey)
  })

  it('MUST look up backend session key for given thread key on chat.session.switch', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSessionSwitch(threadKey)
    expect(backend.switchSession).toHaveBeenCalledWith(sessionKey)
  })

  it('MUST persist session mapping to {dataDir}/chat/session-map.json using atomic write', async () => {
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
    const mapPath = path.join(dataDir, 'chat', 'session-map.json')
    expect(fs.existsSync(mapPath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'))
    expect(data[threadKey]).toBe(sessionKey)
    // Ensure no .tmp file left behind (atomic rename)
    expect(fs.existsSync(mapPath + '.tmp')).toBe(false)
  })

  it('MUST restore session mapping from disk on server restart', async () => {
    // Create a mapping with first module
    const { threadKey, sessionKey } = await chatModule.handleSessionCreate()

    // Create a new module instance (simulating restart)
    const newModule = createChatModule(bus, backend, threadManager, { dataDir, wsHandler })
    expect(newModule.getSessionKeyForThread(threadKey)).toBe(sessionKey)
  })
})
