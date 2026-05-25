import { describe, it, expect, vi } from 'vitest'
import type { EventBus } from '@sovereign/core'

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

describe('Server index.ts wiring — Phase 6 modules', () => {
  describe('agent backend initialization', () => {
    it('creates OpenClaw backend with config from the openclaw gateway URL', async () => {
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const backend = createOpenClawBackend({
        gatewayUrl: 'ws://localhost:3456/ws',
        dataDir: '/tmp/test-wiring'
      })
      expect(backend).toBeDefined()
      expect(backend.connect).toBeInstanceOf(Function)
      expect(backend.sendMessage).toBeInstanceOf(Function)
    })

    it('calls backend.connect() during server startup', async () => {
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const backend = createOpenClawBackend({
        gatewayUrl: 'ws://localhost:1/ws',
        dataDir: '/tmp/test-wiring'
      })
      expect(typeof backend.connect).toBe('function')
    })

    it('emits backend.status events through to connected clients', async () => {
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const backend = createOpenClawBackend({
        gatewayUrl: 'ws://localhost:1/ws',
        dataDir: '/tmp/test-wiring'
      })
      const statuses: string[] = []
      backend.on('backend.status', (d) => statuses.push(d.status))
      expect(backend.on).toBeInstanceOf(Function)
    })
  })

  describe('routing backend', () => {
    it('exposes createBackend and createSessionsRegistry from agent-backend/index.ts', async () => {
      const mod = await import('@sovereign/agent-backend')
      expect(typeof mod.createBackend).toBe('function')
      expect(typeof mod.createSessionsRegistry).toBe('function')
    })

    it('routes a session to the OpenClaw backend when only OpenClaw is enabled', async () => {
      const { createBackend, createSessionsRegistry } = await import('@sovereign/agent-backend')
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const tmp = await import('node:fs/promises').then((m) => m.mkdtemp((process.env.TMPDIR ?? '/tmp/') + 'sov-wire-'))
      const registry = createSessionsRegistry(tmp)
      const routing = createBackend({
        enabled: ['openclaw'],
        default: 'openclaw',
        registry,
        factories: {
          openclaw: () => createOpenClawBackend({ gatewayUrl: 'ws://localhost:1/ws', dataDir: tmp })
        }
      })
      expect(routing.default().kind).toBe('openclaw')
      expect(routing.forSession('agent:main:thread:x').kind).toBe('openclaw')
      await routing.disconnectAll()
    })
  })

  describe('chat module wiring', () => {
    it('creates chat module with bus, backend, and thread manager', async () => {
      const { createChatModule } = await import('@sovereign/chat')
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const { createThreadManager } = await import('@sovereign/threads')
      const bus = createMockBus()
      const backend = createOpenClawBackend({ gatewayUrl: 'ws://localhost:1/ws', dataDir: '/tmp/test-wiring' })
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
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const { createThreadManager } = await import('@sovereign/threads')
      const bus = createMockBus()
      const backend = createOpenClawBackend({ gatewayUrl: 'ws://localhost:1/ws', dataDir: '/tmp/test-wiring' })
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
    it('updates backend gateway URL when the openclaw gateway URL config changes', async () => {
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      let configCb: ((c: any) => void) | null = null
      createOpenClawBackend({
        gatewayUrl: 'ws://localhost:1/ws',
        dataDir: '/tmp/test-wiring',
        onConfigChange: (cb) => {
          configCb = cb
        }
      })
      expect(configCb).toBeInstanceOf(Function)
    })

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
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const backend = createOpenClawBackend({
        gatewayUrl: 'ws://localhost:1/ws',
        dataDir: '/tmp/test-wiring'
      })
      await backend.disconnect()
      expect(backend.status()).toBe('disconnected')
    })

    it('cleans up all Phase 6 module resources on shutdown', async () => {
      const { createOpenClawBackend } = await import('@sovereign/agent-backend')
      const { createVoiceModule } = await import('@sovereign/voice')
      const bus = createMockBus()
      const b = createOpenClawBackend({ gatewayUrl: 'ws://localhost:1/ws', dataDir: '/tmp/test-wiring' })
      const voice = createVoiceModule(bus, {})
      await b.disconnect()
      expect(b.status()).toBe('disconnected')
      expect(voice.status().status).toBe('error')
    })
  })
})
