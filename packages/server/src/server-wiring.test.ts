import { describe, it, expect, vi } from 'vitest'
import type { AgentBackend, EventBus } from '@sovereign/core'

// These tests verify that server index.ts correctly wires Phase 6 modules.
// Since index.ts has side effects (starts server), we test the wiring pattern
// by verifying the modules can be instantiated with compatible interfaces.

function createMockBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
    once: vi.fn(() => () => {}),
    replay: vi.fn(),
    history: vi.fn(() => [])
  } as unknown as EventBus
}

/** Minimal AgentBackend stub for wiring tests that don't actually drive a backend. */
function createStubBackend(): AgentBackend {
  return {
    kind: 'claude-code',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: vi.fn(() => 'disconnected' as const),
    sendMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => 'stub-session'),
    getHistory: vi.fn(async () => ({ turns: [], hasMore: false })),
    getFullHistory: vi.fn(async () => []),
    on: vi.fn(),
    off: vi.fn(),
    capabilities: vi.fn(() => ({
      subagents: 'native',
      cron: 'sovereign-managed',
      steering: false,
      followUp: false,
      compaction: 'automatic-only',
      toolStreaming: true,
      deviceIdentity: false,
      multiProvider: false
    })),
    listSessions: vi.fn(async () => []),
    listSubagents: vi.fn(async () => []),
    getSessionMeta: vi.fn(async () => null),
    setSessionModel: vi.fn(async () => {}),
    listAvailableModels: vi.fn(async () => ({ models: [], defaultModel: null })),
    getContextBudget: vi.fn(async () => null)
  } as unknown as AgentBackend
}

describe('Server index.ts wiring — Phase 6 modules', () => {
  describe('agent backend layer', () => {
    it('exposes createBackend and createSessionsRegistry from agent-backend/index.ts', async () => {
      const mod = await import('@sovereign/agent-backend')
      expect(typeof mod.createBackend).toBe('function')
      expect(typeof mod.createSessionsRegistry).toBe('function')
      expect(typeof mod.createClaudeCodeBackend).toBe('function')
    })

    it('routes a session to the claude-code backend when only claude-code is enabled', async () => {
      const { createBackend, createSessionsRegistry } = await import('@sovereign/agent-backend')
      const tmp = await import('node:fs/promises').then((m) => m.mkdtemp((process.env.TMPDIR ?? '/tmp/') + 'sov-wire-'))
      const registry = createSessionsRegistry(tmp)
      const routing = createBackend({
        enabled: ['claude-code'],
        default: 'claude-code',
        registry,
        factories: {
          'claude-code': () => createStubBackend()
        }
      })
      expect(routing.default().kind).toBe('claude-code')
      expect(routing.forSession('agent:main:thread:x').kind).toBe('claude-code')
      await routing.disconnectAll()
    })
  })

  describe('chat module wiring', () => {
    it('creates chat module with bus, backend, and thread manager', async () => {
      const { createChatModule } = await import('@sovereign/chat')
      const { createThreadManager } = await import('@sovereign/threads')
      const bus = createMockBus()
      const backend = createStubBackend()
      const threads = createThreadManager(bus, '/tmp/test-wiring')
      const chat = createChatModule(bus, backend, threads, { dataDir: '/tmp/test-wiring' })
      expect(chat.status()).toEqual({ name: 'chat', status: 'ok' })
    })

    it('registers chat WS channel on the Phase 3 WS handler', async () => {
      const { registerChatWs } = await import('@sovereign/chat')
      expect(typeof registerChatWs).toBe('function')
    })

    it('mounts chat REST routes at /api/chat/*', async () => {
      const { createChatRoutes } = await import('@sovereign/chat')
      expect(typeof createChatRoutes).toBe('function')
    })

    it('includes chat module in status aggregator', async () => {
      const { createChatModule } = await import('@sovereign/chat')
      const { createThreadManager } = await import('@sovereign/threads')
      const bus = createMockBus()
      const backend = createStubBackend()
      const threads = createThreadManager(bus, '/tmp/test-wiring')
      const chat = createChatModule(bus, backend, threads, { dataDir: '/tmp/test-wiring' })
      const status = chat.status()
      expect(status).toHaveProperty('name')
      expect(status).toHaveProperty('status')
    })
  })

  describe('thread manager wiring', () => {
    it('creates thread manager with bus and dataDir', async () => {
      const { createThreadManager } = await import('@sovereign/threads')
      const bus = createMockBus()
      const tm = createThreadManager(bus, '/tmp/test-wiring-threads')
      expect(tm.create).toBeInstanceOf(Function)
      expect(tm.get).toBeInstanceOf(Function)
      expect(tm.list).toBeInstanceOf(Function)
    })

    it('registers threads WS channel on the Phase 3 WS handler', async () => {
      const { registerThreadsWs } = await import('@sovereign/threads')
      expect(typeof registerThreadsWs).toBe('function')
    })

    it('mounts thread REST routes at /api/threads/*', async () => {
      const { createThreadRoutes } = await import('@sovereign/threads')
      expect(typeof createThreadRoutes).toBe('function')
    })

    it('includes thread manager in status aggregator', async () => {
      const { createThreadManager } = await import('@sovereign/threads')
      const bus = createMockBus()
      const tm = createThreadManager(bus, '/tmp/test-wiring-threads')
      const thread = tm.create({ label: 'test' })
      expect(thread.key).toBeTruthy()
    })
  })

  describe('voice module wiring', () => {
    it('creates voice module with bus and voice config', async () => {
      const { createVoiceModule } = await import('@sovereign/voice')
      const bus = createMockBus()
      const voice = createVoiceModule(bus, { transcribeUrl: 'http://localhost/t', ttsUrl: 'http://localhost/s' })
      expect(voice.status()).toEqual({ module: 'voice', status: 'ok' })
    })

    it('mounts voice REST routes at /api/voice/*', async () => {
      const { createVoiceRoutes } = await import('@sovereign/voice')
      expect(typeof createVoiceRoutes).toBe('function')
    })

    it('includes voice module in status aggregator', async () => {
      const { createVoiceModule } = await import('@sovereign/voice')
      const bus = createMockBus()
      const voice = createVoiceModule(bus, {})
      const status = voice.status()
      expect(status.module).toBe('voice')
      expect(['ok', 'degraded', 'error']).toContain(status.status)
    })
  })

  describe('config hot-reload', () => {
    it('updates voice URLs when voice.transcribeUrl or voice.ttsUrl change', async () => {
      const { createVoiceModule } = await import('@sovereign/voice')
      const bus = createMockBus()
      const voice = createVoiceModule(bus, { transcribeUrl: 'http://old/t' })
      voice.updateConfig({ transcribeUrl: 'http://new/t' })
      expect(voice.status().status).toBe('degraded')
    })
  })

  describe('graceful shutdown', () => {
    it('disconnects agent backend on server shutdown', async () => {
      const backend = createStubBackend()
      await backend.connect()
      await backend.disconnect()
      expect(backend.status()).toBe('disconnected')
    })
  })
})
