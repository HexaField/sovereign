import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createChatModule } from './chat.js'
import type { ChatModule } from './chat.js'
import type { ThreadManager } from '../threads/types.js'
import type { EventBus, AgentBackend, AgentBackendEvents, BackendConnectionStatus } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

function createMockBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    once: vi.fn(() => () => {}),
    replay: vi.fn(),
    history: vi.fn(() => [])
  } as unknown as EventBus
}

function createMockBackend() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  let backendStatus: BackendConnectionStatus = 'connected'
  return {
    _handlers: handlers,
    _setStatus: (status: BackendConnectionStatus) => {
      backendStatus = status
    },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(() => backendStatus),
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
    off: vi.fn()
  }
}

function createMockThreadManager(): ThreadManager {
  let counter = 0
  return {
    create: vi.fn((opts?: { label?: string }) => ({
      key: `thread-${++counter}`,
      label: opts?.label,
      entities: [],
      lastActivity: Date.now(),
      unreadCount: 0,
      agentStatus: 'idle',
      createdAt: Date.now(),
      archived: false
    })),
    get: vi.fn(),
    list: vi.fn(() => []),
    delete: vi.fn(() => true),
    addEntity: vi.fn(),
    removeEntity: vi.fn(),
    getEntities: vi.fn(() => []),
    getThreadsForEntity: vi.fn(() => []),
    addEvent: vi.fn(),
    getEvents: vi.fn(() => [])
  } as unknown as ThreadManager
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

describe('Chat Module Queue Integration', () => {
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-queue-test-'))
    chatModule = createChatModule(bus, backend as unknown as AgentBackend, threadManager, { dataDir, wsHandler })
  })

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('message flow', () => {
    it('should enqueue message on chat.send and broadcast queue update', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadKey, 'hello')
      const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
      const queueCall = calls.find((c) => (c[1] as any).type === 'chat.queue.update')
      expect(queueCall).toBeTruthy()
      expect((queueCall![1] as any).queue).toHaveLength(1)
    })

    it('should auto-process queue when agent is idle', async () => {
      const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadKey, 'hello')
      expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'hello')
    })

    it('should mark message as sending before forwarding to backend', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadKey, 'hello')
      const calls = (wsHandler.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls
      const queueCalls = calls.filter((c) => (c[1] as any).type === 'chat.queue.update')
      // There should be a broadcast that included 'sending' status at some point
      const hadSending = queueCalls.some((c) => {
        const queue = (c[1] as any).queue
        return queue.some((m: any) => m.status === 'sending')
      })
      expect(hadSending).toBe(true)
    })

    it('should process next queued message when agent becomes idle', async () => {
      const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
      emitBackendEvent(backend, 'chat.status', { sessionKey, status: 'working' })
      await chatModule.handleSend(threadKey, 'first')
      await chatModule.handleSend(threadKey, 'second')
      expect(backend.sendMessage).not.toHaveBeenCalled()
      emitBackendEvent(backend, 'chat.status', { sessionKey, status: 'idle' })
      expect(backend.sendMessage).toHaveBeenCalledWith(sessionKey, 'first')
    })

    it('should handle multiple messages queued while agent is busy', async () => {
      const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
      emitBackendEvent(backend, 'chat.status', { sessionKey, status: 'working' })
      await chatModule.handleSend(threadKey, 'one')
      await chatModule.handleSend(threadKey, 'two')
      expect(chatModule.getQueue(threadKey)).toHaveLength(2)
    })
  })

  describe('cancellation', () => {
    it('should cancel queued message and broadcast update', async () => {
      const { threadKey, sessionKey } = await chatModule.handleSessionCreate()
      emitBackendEvent(backend, 'chat.status', { sessionKey, status: 'working' })
      await chatModule.handleSend(threadKey, 'queued')
      const queued = chatModule.getQueue(threadKey)[0]
      const cancelled = chatModule.handleCancel(queued.id)
      expect(cancelled).toBe(true)
      expect(chatModule.getQueue(threadKey)).toHaveLength(0)
    })

    it('should not cancel message already being sent', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      // Make backend hang so the message stays in 'sending' state
      let resolveSend!: () => void
      ;(backend.sendMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSend = resolve
          })
      )
      const sendPromise = chatModule.handleSend(threadKey, 'sending')
      // Queue should have message in 'sending' state now
      const sending = chatModule.getQueue(threadKey)[0]
      expect(sending).toBeTruthy()
      expect(sending.status).toBe('sending')
      const cancelled = chatModule.handleCancel(sending.id)
      expect(cancelled).toBe(false)
      resolveSend()
      await sendPromise
    })
  })

  describe('queue state on connect', () => {
    it('should send queue state alongside history on chat.history request', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      backend._setStatus('disconnected')
      await chatModule.handleSend(threadKey, 'queued')
      await chatModule.handleHistory(threadKey, 'device-1')
      expect(wsHandler.sendTo).toHaveBeenCalledWith(
        'device-1',
        expect.objectContaining({ type: 'chat.queue.update', threadKey })
      )
    })
  })

  describe('multi-device sync', () => {
    it('should broadcast queue updates to all connected devices', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      await chatModule.handleSend(threadKey, 'hello')
      expect(wsHandler.broadcastToChannel).toHaveBeenCalledWith(
        'chat',
        expect.objectContaining({ type: 'chat.queue.update', threadKey })
      )
    })
  })

  describe('error handling', () => {
    it('should re-queue message if backend.send fails', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      ;(backend.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'))
      await chatModule.handleSend(threadKey, 'oops')
      await new Promise((r) => setTimeout(r, 0))
      const queue = chatModule.getQueue(threadKey)
      expect(queue[0].status).toBe('queued')
    })

    it('should not process queue if backend is disconnected', async () => {
      const { threadKey } = await chatModule.handleSessionCreate()
      backend._setStatus('disconnected')
      await chatModule.handleSend(threadKey, 'offline')
      expect(backend.sendMessage).not.toHaveBeenCalled()
      expect(chatModule.getQueue(threadKey)).toHaveLength(1)
    })
  })
})
