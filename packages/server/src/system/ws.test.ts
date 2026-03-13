import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WsHandler, WsLike } from '../ws/handler.js'
import type { EventBus } from '@template/core'
import { registerLogsChannel } from './ws.js'

function createMockWsHandler(): WsHandler & {
  _channels: Map<string, any>
  _sent: Array<{ deviceId: string; msg: any }>
} {
  const channels = new Map<string, any>()
  const sent: Array<{ deviceId: string; msg: any }> = []
  return {
    _channels: channels,
    _sent: sent,
    registerChannel(name: string, options: any) {
      channels.set(name, options)
    },
    handleConnection(_ws: WsLike, _deviceId: string) {},
    broadcast(_msg: any) {},
    broadcastToChannel(_channel: string, _msg: any) {},
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

function createMockBus(): EventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    replay: vi.fn() as any,
    getRecentEvents: vi.fn().mockReturnValue([]),
    subscribe: vi.fn(),
    unsubscribe: vi.fn()
  } as unknown as EventBus
}

describe('Logs WS Channel', () => {
  let ws: ReturnType<typeof createMockWsHandler>
  let bus: EventBus

  beforeEach(() => {
    ws = createMockWsHandler()
    bus = createMockBus()
  })

  describe('§9.3 — Logs WS Channel', () => {
    it('§9.3 — registers logs WS channel', () => {
      registerLogsChannel(ws, bus)
      expect(ws._channels.has('logs')).toBe(true)
    })

    it('§9.3 — captures structured log entries with level, module, message, timestamp', () => {
      const logs = registerLogsChannel(ws, bus)
      logs.log({ level: 'info', module: 'test', message: 'hello' })
      const buffer = logs.getBuffer()
      expect(buffer).toHaveLength(1)
      expect(buffer[0]).toMatchObject({ level: 'info', module: 'test', message: 'hello' })
      expect(typeof buffer[0].timestamp).toBe('number')
    })

    it('§9.3 — broadcasts log entries to logs channel subscribers', () => {
      const broadcastSpy = vi.spyOn(ws, 'broadcastToChannel')
      const logs = registerLogsChannel(ws, bus)
      logs.log({ level: 'warn', module: 'git', message: 'conflict' })
      expect(broadcastSpy).toHaveBeenCalledWith(
        'logs',
        expect.objectContaining({
          type: 'log.entry',
          level: 'warn',
          module: 'git',
          message: 'conflict'
        })
      )
    })

    it('§9.3 — buffers last 1000 log entries', () => {
      const logs = registerLogsChannel(ws, bus)
      for (let i = 0; i < 1050; i++) {
        logs.log({ level: 'debug', module: 'test', message: `msg-${i}` })
      }
      const buffer = logs.getBuffer()
      expect(buffer).toHaveLength(1000)
      expect(buffer[0].message).toBe('msg-50')
      expect(buffer[999].message).toBe('msg-1049')
    })

    it('§9.3 — sends buffered entries to new subscribers on connect', () => {
      const logs = registerLogsChannel(ws, bus)
      logs.log({ level: 'info', module: 'sys', message: 'boot' })
      // Simulate subscriber connecting
      const opts = ws._channels.get('logs')
      opts.onSubscribe('device-1')
      expect(ws._sent).toHaveLength(1)
      expect(ws._sent[0].deviceId).toBe('device-1')
      expect(ws._sent[0].msg.type).toBe('log.history')
      expect(ws._sent[0].msg.entries).toHaveLength(1)
    })

    it('§9.3 — log entries include timestamp, level (debug|info|warn|error), module, message', () => {
      const logs = registerLogsChannel(ws, bus)
      const levels = ['debug', 'info', 'warn', 'error'] as const
      for (const level of levels) {
        logs.log({ level, module: 'mod', message: `${level} msg` })
      }
      const buffer = logs.getBuffer()
      expect(buffer).toHaveLength(4)
      for (let i = 0; i < 4; i++) {
        expect(buffer[i].level).toBe(levels[i])
        expect(typeof buffer[i].timestamp).toBe('number')
        expect(buffer[i].module).toBe('mod')
        expect(buffer[i].message).toBe(`${levels[i]} msg`)
      }
    })
  })
})
