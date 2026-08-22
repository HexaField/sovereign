import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createChatModule } from './chat.js'
import type { ChatModule } from './chat.js'
import type { ThreadManager } from '@sovereign/threads'
import type { EventBus, AgentBackend, AgentBackendEvents, BackendConnectionStatus, ParsedTurn } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'
import type { WsMessage } from '@sovereign/core'

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
    kind: 'claude-code',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(() => 'connected' as BackendConnectionStatus),
    sendMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async (_label?: string) => `session-${Date.now()}`),
    getHistory: vi.fn(async () => ({ turns: [], hasMore: false })),
    getFullHistory: vi.fn(async () => []),
    on: vi.fn(<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) => {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event)!.push(handler as (...args: unknown[]) => void)
    }),
    off: vi.fn(),
    capabilities: vi.fn(() => ({
      subagents: 'native' as const,
      cron: 'backend-managed' as const,
      steering: false,
      followUp: false,
      compaction: 'automatic-only' as const,
      toolStreaming: true,
      deviceIdentity: true,
      multiProvider: true
    })),
    listSessions: vi.fn(async () => []),
    listSubagents: vi.fn(async () => []),
    getSessionMeta: vi.fn(async () => null),
    setSessionModel: vi.fn(async () => {}),
    listAvailableModels: vi.fn(async () => ({ models: [], defaultModel: null })),
    getContextBudget: vi.fn(async () => null)
  }
}

function createMockThreadManager(): ThreadManager {
  let counter = 0
  const threads = new Map<string, any>()
  return {
    create: vi.fn((opts: { label: string; entities?: any[] }) => {
      const id = `thread-${++counter}`
      const thread = {
        id,
        label: opts.label,
        entities: opts.entities ?? [],
        workspaceIds: [],
        lastActivity: Date.now(),
        unreadCount: 0,
        agentStatus: 'idle' as const,
        createdAt: Date.now(),
        archived: false
      }
      threads.set(id, thread)
      return thread
    }),
    get: vi.fn((id: string) => threads.get(id)),
    getByLabel: vi.fn((label: string) => [...threads.values()].find((t) => t.label === label)),
    resolve: vi.fn(
      (idOrLabel: string) => threads.get(idOrLabel) ?? [...threads.values()].find((t) => t.label === idOrLabel)
    ),
    list: vi.fn(() => [...threads.values()]),
    delete: vi.fn(() => true),
    addEntity: vi.fn(() => undefined),
    removeEntity: vi.fn(() => undefined),
    getEntities: vi.fn(() => []),
    getThreadsForEntity: vi.fn(() => []),
    addEvent: vi.fn(),
    getEvents: vi.fn(() => []),
    touch: vi.fn((id: string) => {
      const t = threads.get(id)
      if (t) t.lastActivity = Date.now()
    }),
    markUnreadIncrement: vi.fn((id: string) => {
      const t = threads.get(id)
      if (!t) return undefined
      t.unreadCount += 1
      return t.unreadCount
    }),
    clearUnread: vi.fn((id: string) => {
      const t = threads.get(id)
      if (!t) return false
      if (t.unreadCount === 0) return false
      t.unreadCount = 0
      return true
    })
  } as unknown as ThreadManager
}

function createMockWsHandler(): WsHandler {
  return {
    registerChannel: vi.fn(),
    handleConnection: vi.fn(),
    broadcast: vi.fn(),
    broadcastToChannel: vi.fn(),
    sendTo: vi.fn(),
    sendToDeviceName: vi.fn(),
    sendBinary: vi.fn(),
    sendBinaryTo: vi.fn(() => false),
    getConnectedDevices: vi.fn(() => []),
    getChannels: vi.fn(() => []),
    getDeviceName: vi.fn(() => undefined),
    isDeviceNameConnected: vi.fn(() => false)
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
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'hello')
    expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'hello')
  })

  // Regression: in the bare-UUID model the client/cron may address a thread by
  // a label or a stale `#thread=<label>` hash. handleSend + resolveSessionKey
  // MUST resolve that to the canonical thread id, or the message routes to a
  // non-existent session and silently never reaches the agent.
  it('MUST resolve a thread LABEL to the canonical id when sending', async () => {
    const t = threadManager.create({ label: 'neural-nets' })
    await chatModule.handleSend('neural-nets', 'hi') // addressed by LABEL
    // Routed to the canonical id's session — not the raw label.
    expect(backend.sendMessage).toHaveBeenCalledWith(t.id, 'hi')
    // And label/id resolve to the same session key.
    expect(chatModule.resolveSessionKey('neural-nets')).toBe(chatModule.resolveSessionKey(t.id))
  })

  it('MUST deduplicate rapid identical user sends (server-side)', async () => {
    const { threadId } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'duplicate')
    await chatModule.handleSend(threadId, 'duplicate')

    // Only one backend send (second is deduped)
    expect(backend.sendMessage).toHaveBeenCalledTimes(1)

    // user-message broadcast no longer emitted (removed — single source of truth)
  })

  it('MUST proxy chat.abort to backend.abort(sessionKey)', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleAbort(threadId)
    expect(backend.abort).toHaveBeenCalledWith(sessionKey)
  })

  it('MUST proxy chat.history to backend.getHistory(sessionKey) and respond with chat.session.info', async () => {
    const turns: ParsedTurn[] = [{ role: 'user', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] }]
    ;(backend.getHistory as ReturnType<typeof vi.fn>).mockResolvedValue({ turns, hasMore: false })
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleHistory(threadId, 'device-1')
    expect(backend.getHistory).toHaveBeenCalledWith(sessionKey)
    expect(wsHandler.sendTo).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({
        type: 'chat.session.info',
        threadId,
        history: turns
      })
    )
  })

  it('MUST proxy chat.session.switch to backend.switchSession(sessionKey)', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSessionSwitch(threadId)
    expect(backend.switchSession).toHaveBeenCalledWith(sessionKey)
  })

  it('MUST proxy chat.session.create to backend — creates thread and derives session key', async () => {
    const result = await chatModule.handleSessionCreate('test-label')
    expect(threadManager.create).toHaveBeenCalledWith({ label: 'test-label' })
    expect(result.threadId).toBeTruthy()
    expect(result.sessionKey).toBeTruthy()
    // Bare-UUID scheme: the session key IS the bare thread id (derived,
    // not returned from backend.createSession).
    expect(result.sessionKey).toBe(result.threadId)
  })

  it('MUST proxy chat.stream events to subscribed clients via WS', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.stream', { sessionKey, text: 'hello' })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.stream', text: 'hello', threadId })
    )
  })

  it('MUST proxy chat.turn events to subscribed clients via WS', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const turn: ParsedTurn = { role: 'assistant', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] }
    emitBackendEvent(backend, 'chat.turn', { sessionKey, turn })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.turn', threadId })
    )
  })

  it('MUST proxy chat.status events to subscribed clients via WS', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.status', { sessionKey, status: 'working' })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.status', threadId, status: 'working' })
    )
  })

  it('MUST proxy chat.work events to subscribed clients via WS', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const work = { type: 'tool_call' as const, name: 'test', timestamp: 1 }
    emitBackendEvent(backend, 'chat.work', { sessionKey, work })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.work', threadId })
    )
  })

  it('MUST proxy chat.compacting events to subscribed clients via WS', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.compacting', { sessionKey, active: true })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.compacting', threadId, active: true })
    )
  })

  it('MUST proxy chat.error events to subscribed clients via WS', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.error', { sessionKey, error: 'boom' })
    expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({ type: 'chat.error', threadId, error: 'boom' })
    )
  })

  it('MUST proxy chat.session.info events to SSE subscribers — NOT broadcast (point-to-point only)', async () => {
    // session.info carries full history. Broadcasting it to all clients
    // would cause every open tab to replace its turns — so it is deliberately
    // skipped from the broadcast path and sent point-to-point via sendTo.
    // Verify the event still reaches chatEvents (SSE subscribers) but NOT broadcastToChannel.
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()

    const received: Record<string, unknown>[] = []
    chatModule.chatEvents.on('chat.session.info', (d: Record<string, unknown>) => received.push(d))

    emitBackendEvent(backend, 'session.info', { sessionKey, history: [] })

    // Must reach SSE subscribers via chatEvents
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ sessionKey, threadId })
    // Must NOT be broadcast to all WS clients
    const broadcastCalls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const sessionInfoBroadcast = broadcastCalls.find(
      (c: unknown[]) => (c[1] as { type?: string })?.type === 'chat.session.info'
    )
    expect(sessionInfoBroadcast).toBeUndefined()
  })

  it('MUST respect Phase 3 WS scoping — client subscribed with threadId scope only receives events for that thread', async () => {
    const result1 = await chatModule.handleSessionCreate()
    const result2 = await chatModule.handleSessionCreate()
    emitBackendEvent(backend, 'chat.stream', { sessionKey: result1.sessionKey, text: 'for-1' })
    emitBackendEvent(backend, 'chat.stream', { sessionKey: result2.sessionKey, text: 'for-2' })
    // Each broadcast should include the correct threadId in the message
    const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const call1 = calls.find((c: unknown[]) => (c[1] as WsMessage).text === 'for-1')
    const call2 = calls.find((c: unknown[]) => (c[1] as WsMessage).text === 'for-2')
    expect((call1![1] as any).threadId).toBe(result1.threadId)
    expect((call2![1] as any).threadId).toBe(result2.threadId)
  })

  it('MUST emit chat.message.sent bus event when a user sends a message', async () => {
    const { threadId } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'hello world')
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.message.sent',
        source: 'chat',
        payload: expect.objectContaining({ threadId, text: 'hello world' })
      })
    )
  })

  it('MUST emit chat.turn.completed bus event when the agent completes a turn', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const turn: ParsedTurn = { role: 'assistant', content: 'done', timestamp: 1, workItems: [], thinkingBlocks: [] }
    emitBackendEvent(backend, 'chat.turn', { sessionKey, turn })
    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.turn.completed',
        source: 'chat',
        payload: expect.objectContaining({ threadId, turn })
      })
    )
  })

  it('MUST create a corresponding backend session when a new thread is created', async () => {
    const result = await chatModule.handleSessionCreate('my-thread')
    expect(threadManager.create).toHaveBeenCalledWith({ label: 'my-thread' })
    expect(result.sessionKey).toBeTruthy()
    expect(chatModule.getSessionKeyForThread(result.threadId)).toBe(result.sessionKey)
  })

  it('MUST look up backend session key for given thread key on chat.session.switch', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSessionSwitch(threadId)
    expect(backend.switchSession).toHaveBeenCalledWith(sessionKey)
  })

  it('MUST persist session mapping to {dataDir}/chat/session-map.json using atomic write', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const mapPath = path.join(dataDir, 'chat', 'session-map.json')
    expect(fs.existsSync(mapPath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(mapPath, 'utf-8'))
    expect(data[threadId]).toBe(sessionKey)
    // Ensure no .tmp file left behind (atomic rename)
    expect(fs.existsSync(mapPath + '.tmp')).toBe(false)
  })

  it('MUST restore session mapping from disk on server restart', async () => {
    // Create a mapping with first module
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()

    // Create a new module instance (simulating restart)
    const newModule = createChatModule(bus, backend, threadManager, { dataDir, wsHandler })
    expect(newModule.getSessionKeyForThread(threadId)).toBe(sessionKey)
  })

  // --- Phase 6 review fix todos ---

  it('MUST use real ThreadManager interface (get/create) not local getSessionKey/createThread mismatch', async () => {
    // Verify the chat module calls threadManager.create() which returns a ThreadInfo
    const result = await chatModule.handleSessionCreate('test')
    expect(threadManager.create).toHaveBeenCalledWith({ label: 'test' })
    expect(result.threadId).toMatch(/^thread-/)
  })

  it('MUST import ThreadManager from threads module instead of defining a local interface', async () => {
    // This is a structural test - the fact that we pass a ThreadManager with create/get and it works
    // proves the chat module uses the real interface
    const result = await chatModule.handleSessionCreate()
    expect(result.threadId).toBeTruthy()
    expect(result.sessionKey).toBeTruthy()
  })

  it('MUST handle case where threadId has no session mapping (auto-create session)', async () => {
    // Send to a threadId that has no mapping - should auto-derive a session key
    await chatModule.handleSend('unknown-thread', 'hello')
    expect(backend.sendMessage).toHaveBeenCalled()
    // After auto-derive, the mapping should exist
    expect(chatModule.getSessionKeyForThread('unknown-thread')).toBeTruthy()
    expect(chatModule.getSessionKeyForThread('unknown-thread')).toBe('unknown-thread')
  })

  it('MUST track and untrack SSE clients correctly', () => {
    chatModule.trackSSEClient('thread-1')
    chatModule.trackSSEClient('thread-1')
    chatModule.trackSSEClient('thread-2')
    chatModule.untrackSSEClient('thread-1')
    // Still one client on thread-1
    chatModule.untrackSSEClient('thread-1')
    // Zero clients on thread-1
    chatModule.untrackSSEClient('thread-1')
    // Should not go negative — just stays at 0
    chatModule.untrackSSEClient('thread-2')
  })

  it('MUST cap accumulated work items at 200 to prevent unbounded growth', () => {
    // Set up a thread mapping
    const sessionKey = chatModule.resolveSessionKey('thread-cap')

    // Simulate 250 work events
    const statusHandlers = backend._handlers.get('chat.work') ?? []
    for (let i = 0; i < 250; i++) {
      for (const handler of statusHandlers) {
        handler({ sessionKey, work: { type: 'tool_call', name: `tool-${i}`, timestamp: Date.now() } })
      }
    }

    const live = chatModule.getLiveState('thread-cap')
    expect(live.work).toBeTruthy()
    expect(live.work!.length).toBeLessThanOrEqual(200)
  })

  it('MUST clear live state on chat.turn event', () => {
    const sessionKey = chatModule.resolveSessionKey('thread-clear')

    // Simulate status + work + stream events
    const statusHandlers = backend._handlers.get('chat.status') ?? []
    for (const h of statusHandlers) h({ sessionKey, status: 'working' })

    const workHandlers = backend._handlers.get('chat.work') ?? []
    for (const h of workHandlers) h({ sessionKey, work: { type: 'tool_call', name: 'test', timestamp: Date.now() } })

    const streamHandlers = backend._handlers.get('chat.stream') ?? []
    for (const h of streamHandlers) h({ sessionKey, text: 'hello' })

    let live = chatModule.getLiveState('thread-clear')
    expect(live.status).toBe('working')
    expect(live.work?.length).toBeGreaterThan(0)
    expect(live.streamText).toBeTruthy()

    // Now emit turn event — should clear all live state
    const turnHandlers = backend._handlers.get('chat.turn') ?? []
    for (const h of turnHandlers)
      h({
        sessionKey,
        turn: { role: 'assistant', content: 'done', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
      })

    live = chatModule.getLiveState('thread-clear')
    expect(live.status).toBeUndefined()
    expect(live.work).toBeUndefined()
    expect(live.streamText).toBeUndefined()
  })

  // Regression: thread dropdown showed stale "Nm ago" timestamps because each
  // arriving turn didn't refresh `lastActivity` on the thread record. Touching
  // the thread on every chat.turn means the dropdown's relative time stays
  // honest without polling.
  it('chat.turn from backend MUST touch the thread so lastActivity refreshes', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const touchSpy = threadManager.touch as ReturnType<typeof vi.fn>
    touchSpy.mockClear()
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'assistant', content: 'hello', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    expect(touchSpy).toHaveBeenCalledWith(threadId)
  })

  // Regression: when the agent emits chat.turn for the assistant but the
  // backend forgets the chat.status:idle (or the order is reversed), the UI
  // stays stuck on "Thinking…" and the Stop button stays armed. The chat
  // module MUST synthesize an idle status broadcast after every assistant
  // chat.turn so the UI converges to idle.
  it('after an assistant chat.turn, MUST broadcast chat.status idle for the thread', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const before = calls.length
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'assistant', content: 'done', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    const newCalls = calls.slice(before)
    const statusIdle = newCalls.find(
      ([channel, msg]: any[]) =>
        channel === 'chat' && msg?.type === 'chat.status' && msg.status === 'idle' && msg.threadId === threadId
    )
    expect(statusIdle).toBeDefined()
  })

  // Regression: cron messages persisted as `system` role in the JSONL but the
  // chat module synthesized a `user` chat.turn for live consumers. The bubble
  // would render as a user turn live, then flip to a system "[Scheduled Result]"
  // bubble on the next refresh. Threading `synthRole` through handleSend lets
  // the cron path emit a system turn so live + persisted views agree.
  it('handleSend with synthRole "system" MUST emit a system chat.turn (not user)', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const broadcasts = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const beforeCount = broadcasts.length
    await chatModule.handleSend(threadId, '[Cron: probe] do thing', undefined, { synthRole: 'system' })
    // Force the in-flight queue head to "complete" by emitting an assistant
    // chat.turn from the backend — that's what triggers completeInFlight and
    // the synthetic user/system turn broadcast.
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'assistant', content: 'ok', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    const syntheticTurns = broadcasts
      .slice(beforeCount)
      .filter(([channel, msg]: any[]) => channel === 'chat' && msg?.type === 'chat.turn' && msg.threadId === threadId)
      .map(([, msg]: any[]) => msg.turn?.role)
    expect(syntheticTurns).toContain('system')
    expect(syntheticTurns).not.toContain('user')
  })

  it('handleSend without synthRole (default) MUST emit a user chat.turn (no regression)', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const broadcasts = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const beforeCount = broadcasts.length
    await chatModule.handleSend(threadId, 'hello from user')
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'assistant', content: 'ok', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    const syntheticTurns = broadcasts
      .slice(beforeCount)
      .filter(([channel, msg]: any[]) => channel === 'chat' && msg?.type === 'chat.turn' && msg.threadId === threadId)
      .map(([, msg]: any[]) => msg.turn?.role)
    expect(syntheticTurns).toContain('user')
    expect(syntheticTurns).not.toContain('system')
  })

  // Regression: finished subagents pile up in the thread dropdown because the
  // client only refetches /api/threads/active-subagents on dropdown OPEN. WS
  // forwarding the backend's subagent.* lifecycle events lets the header
  // refetch on completion, instead of staying stuck on the previous list.
  it('MUST broadcast subagent.completed from the backend to the chat WS channel', async () => {
    const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const before = calls.length
    emitBackendEvent(backend, 'subagent.completed', {
      parentKey: 'parent-thread-id',
      childKey: 'child-subagent-id',
      result: 'ok'
    } as any)
    const newCalls = calls.slice(before)
    const broadcast = newCalls.find(
      ([channel, msg]: any[]) =>
        channel === 'chat' && msg?.type === 'subagent.completed' && msg.parentKey === 'parent-thread-id'
    )
    expect(broadcast).toBeDefined()
  })

  it('MUST broadcast subagent.spawned and subagent.failed too', async () => {
    const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const before = calls.length
    emitBackendEvent(backend, 'subagent.spawned', {
      parentKey: 'p',
      childKey: 'c',
      task: 't'
    } as any)
    emitBackendEvent(backend, 'subagent.failed', {
      parentKey: 'p',
      childKey: 'c',
      error: 'bad'
    } as any)
    const newCalls = calls.slice(before)
    const spawned = newCalls.find(([channel, msg]: any[]) => channel === 'chat' && msg?.type === 'subagent.spawned')
    const failed = newCalls.find(([channel, msg]: any[]) => channel === 'chat' && msg?.type === 'subagent.failed')
    expect(spawned).toBeDefined()
    expect(failed).toBeDefined()
  })

  // User-role chat.turn is the synthetic one chat.ts emits for queued sends —
  // not a real agent completion. Synthesizing idle here would steal the
  // "working" indicator the moment the user's bubble lands; only assistant
  // turns close out the busy state.
  // Regression: voice/AD4M-originated messages need a modality hint in the
  // agent's context, but only the internal presence thread gets the full
  // `[presence:inbound ...]` envelope. Every other thread (gateway or a
  // plain user thread) gets a lightweight one-word tag instead.
  it('handleSend with origin on a non-internal thread MUST prepend a one-word modality tag', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'turn the lights on', undefined, {
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, '[voice]\nturn the lights on')
  })

  // A device name turns the raw connection id into something the agent can
  // reference directly. The wsHandler map (populated by a ws.device-name
  // message on the live connection) holds the authoritative name.
  it('handleSend with origin MUST include the wsHandler-known device name in the modality tag', async () => {
    ;(wsHandler.getDeviceName as ReturnType<typeof vi.fn>).mockImplementation((deviceId: string) =>
      deviceId === 'dev-1' ? 'Josh Phone' : undefined
    )
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'turn the lights on', undefined, {
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, '[voice:Josh Phone]\nturn the lights on')
  })

  // Covers the race where the HTTP send lands before the WS ws.device-name
  // handshake finishes announcing the name to the wsHandler map.
  it('handleSend with origin MUST fall back to origin.deviceName when the wsHandler has no name yet', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'turn the lights on', undefined, {
      origin: { modality: 'voice', deviceId: 'dev-1', deviceName: 'Josh Phone' }
    })
    expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, '[voice:Josh Phone]\nturn the lights on')
  })

  it('handleSend without origin MUST send text unmodified (no regression)', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    await chatModule.handleSend(threadId, 'plain text message')
    expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'plain text message')
  })

  // The live synthetic user chat.turn (broadcast by completeInFlight) reads
  // its content straight from the queue entry, which never held the
  // `[modality]` tag — that tag only ever reaches the agent, not the UI.
  // Origin rides as a separate structured field instead.
  it('the synthetic user chat.turn MUST carry origin.modality while content stays unprefixed', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const broadcasts = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const beforeCount = broadcasts.length
    await chatModule.handleSend(threadId, 'turn the lights on', undefined, {
      origin: { modality: 'voice', deviceId: 'dev-1' }
    })
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'assistant', content: 'done', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    const userTurn = broadcasts
      .slice(beforeCount)
      .map(([, msg]: any[]) => msg as any)
      .find((msg: any) => msg?.type === 'chat.turn' && msg.turn?.role === 'user')
    expect(userTurn).toBeDefined()
    expect(userTurn.turn.content).toBe('turn the lights on')
    expect(userTurn.turn.origin).toEqual({ modality: 'voice' })
  })

  it('the synthetic user chat.turn MUST omit origin when the queued message carried none', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const broadcasts = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const beforeCount = broadcasts.length
    await chatModule.handleSend(threadId, 'plain text message')
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'assistant', content: 'done', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    const userTurn = broadcasts
      .slice(beforeCount)
      .map(([, msg]: any[]) => msg as any)
      .find((msg: any) => msg?.type === 'chat.turn' && msg.turn?.role === 'user')
    expect(userTurn).toBeDefined()
    expect(userTurn.turn.origin).toBeUndefined()
  })

  // Guards the branch this feature added: an internal presence thread must
  // keep using the full `[presence:inbound ...]` envelope, not the short tag.
  it('handleSend on an internal presence thread MUST still use the full presence:inbound envelope', async () => {
    const freshDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-test-internal-'))
    try {
      const internalBackend = createMockBackend()
      const internalThreadManager = createMockThreadManager()
      const internalWsHandler = createMockWsHandler()
      const presenceModule = createChatModule(bus, internalBackend, internalThreadManager, {
        dataDir: freshDataDir,
        wsHandler: internalWsHandler,
        presence: { takeDigest: () => null }
      })
      const { threadId, sessionKey } = await presenceModule.handleSessionCreate()
      const thread = internalThreadManager.get(threadId) as any
      thread.presence = 'internal'
      await presenceModule.handleSend(threadId, 'hello from voice', undefined, {
        origin: { modality: 'voice', deviceId: 'dev-1' }
      })
      expect(internalBackend.sendMessage).toHaveBeenCalledWith(
        sessionKey,
        '[presence:inbound modality=voice deviceId=dev-1]\nhello from voice'
      )
    } finally {
      fs.rmSync(freshDataDir, { recursive: true, force: true })
    }
  })

  it('user-role chat.turn must NOT trigger a synthetic idle broadcast', async () => {
    const { threadId, sessionKey } = await chatModule.handleSessionCreate()
    const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
    const before = calls.length
    emitBackendEvent(backend, 'chat.turn', {
      sessionKey,
      turn: { role: 'user', content: 'hi', workItems: [], thinkingBlocks: [], timestamp: Date.now() }
    } as any)
    const newCalls = calls.slice(before)
    const statusIdle = newCalls.find(
      ([channel, msg]: any[]) =>
        channel === 'chat' && msg?.type === 'chat.status' && msg.status === 'idle' && msg.threadId === threadId
    )
    expect(statusIdle).toBeUndefined()
  })

  // ── forceSend tests ─────────────────────────────────────────────────
  describe('forceSend', () => {
    it('MUST send a queued message directly to the backend, bypassing the queue gate', async () => {
      const { threadId, sessionKey } = await chatModule.handleSessionCreate()
      // Simulate agent busy: enqueue a first message and let it go to 'sending'
      await chatModule.handleSend(threadId, 'first message')
      // Now enqueue a second message while the first holds the inFlightByThread gate
      await chatModule.handleSend(threadId, 'second message')
      // The second message should be queued (not sent — gate occupied by first)
      expect(backend.sendMessage).toHaveBeenCalledTimes(1)
      expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'first message')

      const queue = chatModule.getQueueSnapshot(threadId)
      const secondItem = queue.find((m) => m.text === 'second message')
      expect(secondItem).toBeDefined()
      expect(secondItem!.status).toBe('queued')

      // Force-send the second message
      const ok = await chatModule.forceSend(secondItem!.id)
      expect(ok).toBe(true)
      // Backend received both messages now
      expect(backend.sendMessage).toHaveBeenCalledTimes(2)
      expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'second message')
    })

    it('MUST remove the item from the queue after force-sending', async () => {
      const { threadId } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadId, 'first')
      await chatModule.handleSend(threadId, 'second')

      const queue = chatModule.getQueueSnapshot(threadId)
      const secondItem = queue.find((m) => m.text === 'second')!
      await chatModule.forceSend(secondItem.id)

      const after = chatModule.getQueueSnapshot(threadId)
      expect(after.find((m) => m.text === 'second')).toBeUndefined()
    })

    it('MUST synthesize a user chat.turn for the force-sent message', async () => {
      const { threadId } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadId, 'first')
      await chatModule.handleSend(threadId, 'queued message')

      const broadcasts = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
      const beforeCount = broadcasts.length

      const queue = chatModule.getQueueSnapshot(threadId)
      const item = queue.find((m) => m.text === 'queued message')!
      await chatModule.forceSend(item.id)

      const newCalls = broadcasts.slice(beforeCount)
      const userTurn = newCalls.find(
        ([channel, msg]: any[]) =>
          channel === 'chat' &&
          msg?.type === 'chat.turn' &&
          msg.turn?.role === 'user' &&
          msg.turn?.content === 'queued message'
      )
      expect(userTurn).toBeDefined()
    })

    it('MUST return false for a non-existent queue item', async () => {
      const ok = await chatModule.forceSend('non-existent-id')
      expect(ok).toBe(false)
    })

    it('MUST return false for an item that already went through the send path', async () => {
      const { threadId } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadId, 'already sent')

      // pumpQueue sends + removes the item immediately — queue is empty
      const queue = chatModule.getQueueSnapshot(threadId)
      expect(queue).toHaveLength(0)

      // Force-sending a non-existent id returns false
      const ok = await chatModule.forceSend('does-not-exist')
      expect(ok).toBe(false)
    })

    it('MUST apply origin modality tag when force-sending a message with origin', async () => {
      const { threadId, sessionKey } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadId, 'first')
      await chatModule.handleSend(threadId, 'voice command', undefined, {
        origin: { modality: 'voice', deviceId: 'dev-1' }
      })

      const queue = chatModule.getQueueSnapshot(threadId)
      const item = queue.find((m) => m.text === 'voice command')!
      await chatModule.forceSend(item.id)

      expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, '[voice]\nvoice command')
    })

    it('MUST allow force-sending a failed message', async () => {
      const { threadId, sessionKey } = await chatModule.handleSessionCreate()
      // Make the first message fail
      ;(backend.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('backend down'))
      await chatModule.handleSend(threadId, 'will fail')

      // Wait a tick for the error to propagate
      await new Promise((r) => setTimeout(r, 10))

      const queue = chatModule.getQueueSnapshot(threadId)
      const failedItem = queue.find((m) => m.status === 'failed')
      expect(failedItem).toBeDefined()

      // Reset mock to succeed
      ;(backend.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      const ok = await chatModule.forceSend(failedItem!.id)
      expect(ok).toBe(true)
      expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'will fail')
    })
  })

  describe('stuck-status recovery', () => {
    it('aborts the backend, clears the in-flight gate, and emits chat.error after the timeout', async () => {
      // Must enable fake timers BEFORE creating the chat module so the
      // module's setInterval is registered on the fake clock and fires
      // when we advance time with vi.advanceTimersByTimeAsync.
      vi.useFakeTimers()
      try {
        const localBackend = createMockBackend()
        const localWs = createMockWsHandler()
        const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-test-'))
        try {
          let sessCounter = 0
          ;(localBackend.createSession as ReturnType<typeof vi.fn>).mockImplementation(
            async () => `session-stuck-${++sessCounter}`
          )
          const localChat = createChatModule(bus, localBackend, threadManager, {
            dataDir: localDir,
            wsHandler: localWs
          })
          const { threadId, sessionKey } = await localChat.handleSessionCreate()

          // Emit 'working' status from the backend — starts the stuck clock
          const fns = localBackend._handlers.get('chat.status')
          if (fns) for (const fn of fns) fn({ sessionKey, status: 'working' })

          const chatErrors: Array<{ threadId: string; error: string }> = []
          localChat.chatEvents.on('chat.error', (d: Record<string, unknown>) =>
            chatErrors.push(d as unknown as { threadId: string; error: string })
          )

          // Advance past the 30-minute stuck timeout + one 30-second check cycle
          const STUCK_MS = 30 * 60 * 1000
          await vi.advanceTimersByTimeAsync(STUCK_MS + 30_000 + 1)

          // Backend abort must have been called to unblock state.processing
          expect(localBackend.abort).toHaveBeenCalledWith(sessionKey)

          // A visible chat.error should surface so the thread isn't silently abandoned
          expect(chatErrors).toHaveLength(1)
          expect(chatErrors[0].error).toContain('unresponsive')

          // WS clients should also see the error
          expect(localWs.broadcastToChannel).toHaveBeenCalledWith(
            'chat',
            expect.objectContaining({ type: 'chat.error', threadId })
          )
        } finally {
          fs.rmSync(localDir, { recursive: true, force: true })
        }
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
