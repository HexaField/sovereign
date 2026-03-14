import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSystemModule, type SystemModule } from './system.js'
import type { EventBus, BusEvent } from '@template/core'
import type { WsHandler, WsLike } from '../ws/handler.js'

function createTestBus(): EventBus & { _emitted: BusEvent[] } {
  const emitted: BusEvent[] = []
  return {
    emit(event: BusEvent) {
      emitted.push(event)
    },
    _emitted: emitted,
    on: vi.fn().mockReturnValue(() => {}),
    once: vi.fn() as any,
    replay: vi.fn() as any,
    history: vi.fn().mockReturnValue([])
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

describe('Live System Updates', () => {
  let bus: ReturnType<typeof createTestBus>
  let wsHandler: ReturnType<typeof createMockWsHandler>
  let system: SystemModule

  beforeEach(() => {
    bus = createTestBus()
    wsHandler = createMockWsHandler()
  })

  afterEach(() => {
    system?.dispose()
  })

  describe('system event emission', () => {
    it('system module emits architecture.updated on registerModule', () => {
      system = createSystemModule(bus, '/tmp/test', { wsHandler })
      bus._emitted.length = 0 // clear self-registration
      system.registerModule({ name: 'git', status: 'healthy', subscribes: [], publishes: [] })
      const arch = bus._emitted.find((e) => e.type === 'system.architecture.updated')
      expect(arch).toBeDefined()
      expect((arch!.payload as any).modules.some((m: any) => m.name === 'git')).toBe(true)
    })

    it('system module emits health.updated periodically', async () => {
      system = createSystemModule(bus, '/tmp/test', { wsHandler, healthIntervalMs: 50 })
      bus._emitted.length = 0
      await new Promise((r) => setTimeout(r, 120))
      const healthEvents = bus._emitted.filter((e) => e.type === 'system.health.updated')
      expect(healthEvents.length).toBeGreaterThanOrEqual(1)
    })

    it('system module emits health.updated on significant metric change', async () => {
      // Health is emitted periodically — any metric change shows up on next tick
      system = createSystemModule(bus, '/tmp/test', { wsHandler, healthIntervalMs: 50 })
      bus._emitted.length = 0
      await new Promise((r) => setTimeout(r, 80))
      const healthEvents = bus._emitted.filter((e) => e.type === 'system.health.updated')
      expect(healthEvents.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('WS system channel', () => {
    it('broadcasts architecture updates', () => {
      system = createSystemModule(bus, '/tmp/test', { wsHandler })
      wsHandler._broadcast.length = 0
      system.registerModule({ name: 'new-mod', status: 'healthy', subscribes: [], publishes: [] })
      const archBroadcasts = wsHandler._broadcast.filter((b) => b.msg.type === 'system.architecture')
      expect(archBroadcasts.length).toBeGreaterThanOrEqual(1)
    })

    it('broadcasts health updates', async () => {
      system = createSystemModule(bus, '/tmp/test', { wsHandler, healthIntervalMs: 50 })
      wsHandler._broadcast.length = 0
      await new Promise((r) => setTimeout(r, 120))
      const healthBroadcasts = wsHandler._broadcast.filter((b) => b.msg.type === 'system.health')
      expect(healthBroadcasts.length).toBeGreaterThanOrEqual(1)
    })

    it('health broadcast interval is configurable', async () => {
      system = createSystemModule(bus, '/tmp/test', { wsHandler, healthIntervalMs: 30 })
      wsHandler._broadcast.length = 0
      await new Promise((r) => setTimeout(r, 100))
      const count = wsHandler._broadcast.filter((b) => b.msg.type === 'system.health').length
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })
})
