// Tests for ChatModule.injectExternalTurn — regression coverage for the
// thread-to-thread messaging fix (presence_reply_text path).
//
// The method runs the full turn lifecycle: WS broadcast, chatEvents emit,
// bus chat.turn.completed, threadManager.touch, and idle-status synthesis.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createChatModule } from './chat.js'
import type { EventBus, AgentBackend } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'
import type { ThreadManager } from '@sovereign/threads'

function makeBus(): EventBus & { emitted: Array<{ type: string; payload: unknown }> } {
  const emitter = new EventEmitter()
  const emitted: Array<{ type: string; payload: unknown }> = []
  return {
    emitted,
    emit(event: { type: string; [k: string]: unknown }) {
      emitted.push(event as any)
      emitter.emit(event.type, event)
    },
    on(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.on(type, handler)
      return () => emitter.off(type, handler)
    },
    off(type: string, handler: (event: { payload: unknown }) => void) {
      emitter.off(type, handler)
    }
  } as any
}

function makeBackend(): AgentBackend {
  const emitter = new EventEmitter()
  return {
    kind: 'claude-code',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    getHistory: vi.fn(async () => ({ turns: [], hasMore: false })),
    getFullHistory: vi.fn(async () => []),
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => 'session-1'),
    status: vi.fn(() => ({ connected: true, kind: 'claude-code' as const })),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => emitter.on(event, handler)),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => emitter.off(event, handler)),
    capabilities: vi.fn(() => ({
      subagents: 'native' as const,
      cron: 'sovereign-managed' as const,
      steering: true,
      followUp: true,
      compaction: 'automatic-only' as const,
      toolStreaming: true,
      deviceIdentity: true,
      multiProvider: false
    })),
    listSessions: vi.fn(async () => []),
    listSubagents: vi.fn(async () => []),
    getSessionMeta: vi.fn(async () => null),
    setSessionModel: vi.fn(async () => {}),
    listAvailableModels: vi.fn(async () => ({ models: [], defaultModel: null }))
  } as any
}

function makeThreadManager(): ThreadManager & { touched: string[] } {
  const touched: string[] = []
  return {
    touched,
    create: vi.fn(() => ({ id: 't1', label: 'test' })),
    get: vi.fn(() => ({ id: 't1', label: 'test' })),
    list: vi.fn(() => []),
    touch: vi.fn((id: string) => {
      touched.push(id)
    }),
    delete: vi.fn(),
    update: vi.fn(),
    getPresenceThread: vi.fn(() => null)
  } as any
}

function makeWsHandler(): WsHandler & { broadcasts: Array<{ channel: string; data: unknown }> } {
  const broadcasts: Array<{ channel: string; data: unknown }> = []
  return {
    broadcasts,
    registerChannel: vi.fn(),
    handleConnection: vi.fn(),
    broadcast: vi.fn(),
    broadcastToChannel: vi.fn((channel: string, data: unknown) => {
      broadcasts.push({ channel, data })
    }),
    sendTo: vi.fn(),
    sendBinary: vi.fn(),
    sendBinaryTo: vi.fn(() => false),
    getConnectedDevices: vi.fn(() => []),
    getChannels: vi.fn(() => [])
  }
}

describe('injectExternalTurn', () => {
  let bus: ReturnType<typeof makeBus>
  let backend: ReturnType<typeof makeBackend>
  let threadManager: ReturnType<typeof makeThreadManager>
  let wsHandler: ReturnType<typeof makeWsHandler>

  beforeEach(() => {
    bus = makeBus()
    backend = makeBackend()
    threadManager = makeThreadManager()
    wsHandler = makeWsHandler()
  })

  it('broadcasts the turn via WS on the chat channel', () => {
    const chat = createChatModule(bus, backend, threadManager, { wsHandler })
    chat.injectExternalTurn('thread-1', 'hello from presence')

    const turnBroadcast = wsHandler.broadcasts.find((b) => b.channel === 'chat' && (b.data as any).type === 'chat.turn')
    expect(turnBroadcast).toBeDefined()
    const data = turnBroadcast!.data as any
    expect(data.threadId).toBe('thread-1')
    expect(data.turn.role).toBe('assistant')
    expect(data.turn.content).toBe('hello from presence')
  })

  it('emits chat.turn on the chatEvents emitter', () => {
    const chat = createChatModule(bus, backend, threadManager, { wsHandler })
    const received: unknown[] = []
    chat.chatEvents.on('chat.turn', (d: unknown) => received.push(d))

    chat.injectExternalTurn('thread-1', 'test content')

    expect(received).toHaveLength(1)
    expect((received[0] as any).threadId).toBe('thread-1')
    expect((received[0] as any).turn.content).toBe('test content')
  })

  it('emits chat.turn.completed on the event bus', () => {
    const chat = createChatModule(bus, backend, threadManager, { wsHandler })
    chat.injectExternalTurn('thread-1', 'bus test')

    const busEvent = bus.emitted.find((e) => e.type === 'chat.turn.completed')
    expect(busEvent).toBeDefined()
    expect((busEvent!.payload as any).threadId).toBe('thread-1')
    expect((busEvent!.payload as any).turn.content).toBe('bus test')
  })

  it('touches the thread via threadManager', () => {
    const chat = createChatModule(bus, backend, threadManager, { wsHandler })
    chat.injectExternalTurn('thread-1', 'touch test')

    expect(threadManager.touched).toContain('thread-1')
  })

  it('synthesises an idle status after the turn', () => {
    const chat = createChatModule(bus, backend, threadManager, { wsHandler })
    const statusEvents: unknown[] = []
    chat.chatEvents.on('chat.status', (d: unknown) => statusEvents.push(d))

    chat.injectExternalTurn('thread-1', 'idle test')

    const idleBroadcast = wsHandler.broadcasts.find(
      (b) => b.channel === 'chat' && (b.data as any).type === 'chat.status'
    )
    expect(idleBroadcast).toBeDefined()
    expect((idleBroadcast!.data as any).status).toBe('idle')
    expect((idleBroadcast!.data as any).threadId).toBe('thread-1')

    expect(statusEvents).toHaveLength(1)
    expect((statusEvents[0] as any).status).toBe('idle')
  })

  it('survives a deleted thread (touch throws)', () => {
    threadManager.touch = vi.fn(() => {
      throw new Error('thread deleted')
    })
    const chat = createChatModule(bus, backend, threadManager, { wsHandler })

    // Should not throw — the catch swallows the error.
    expect(() => chat.injectExternalTurn('gone-thread', 'should not throw')).not.toThrow()

    // The bus event still fires before the touch.
    const busEvent = bus.emitted.find((e) => e.type === 'chat.turn.completed')
    expect(busEvent).toBeDefined()
  })

  it('works without a WS handler (no WS broadcast)', () => {
    const chat = createChatModule(bus, backend, threadManager)
    const received: unknown[] = []
    chat.chatEvents.on('chat.turn', (d: unknown) => received.push(d))

    // Should not throw — WS broadcasting skips gracefully.
    expect(() => chat.injectExternalTurn('thread-1', 'no ws')).not.toThrow()

    // chatEvents still fire.
    expect(received).toHaveLength(1)
    expect((received[0] as any).turn.content).toBe('no ws')
  })
})
