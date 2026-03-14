import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@sovereign/core'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { registerPlanningWs } from './ws.js'
import type { WsHandler } from '../ws/handler.js'

function makeBus() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-ws-'))
  return createEventBus(tmp)
}

function makeMockWs(): WsHandler {
  return {
    registerChannel: vi.fn(),
    handleConnection: vi.fn(),
    broadcast: vi.fn(),
    broadcastToChannel: vi.fn(),
    sendTo: vi.fn(),
    sendBinary: vi.fn(),
    getConnectedDevices: vi.fn().mockReturnValue([]),
    getChannels: vi.fn().mockReturnValue([])
  }
}

describe('Planning WebSocket', () => {
  let bus: ReturnType<typeof makeBus>
  let ws: WsHandler

  beforeEach(() => {
    bus = makeBus()
    ws = makeMockWs()
  })

  describe('2.3 WebSocket Integration', () => {
    it('MUST register a "planning" WS channel', () => {
      registerPlanningWs(ws, bus)
      expect(ws.registerChannel).toHaveBeenCalledWith(
        'planning',
        expect.objectContaining({
          serverMessages: expect.arrayContaining([
            'planning.graph.updated',
            'planning.sync.completed',
            'planning.cycle.detected'
          ])
        })
      )
    })

    it('MUST send planning.graph.updated when dependency graph changes', async () => {
      registerPlanningWs(ws, bus)
      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId: 'org1' }
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(ws.broadcastToChannel).toHaveBeenCalledWith(
        'planning',
        expect.objectContaining({ type: 'planning.graph.updated', orgId: 'org1' }),
        { orgId: 'org1' }
      )
    })

    it('MUST send planning.sync.completed on sync completion', async () => {
      registerPlanningWs(ws, bus)
      bus.emit({
        type: 'planning.sync.completed',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId: 'org1', parsed: 5 }
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(ws.broadcastToChannel).toHaveBeenCalledWith(
        'planning',
        expect.objectContaining({ type: 'planning.sync.completed', orgId: 'org1' }),
        { orgId: 'org1' }
      )
    })

    it('MUST send planning.cycle.detected when cycles found', async () => {
      registerPlanningWs(ws, bus)
      bus.emit({
        type: 'planning.cycle.detected',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId: 'org1', cycles: [] }
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(ws.broadcastToChannel).toHaveBeenCalledWith(
        'planning',
        expect.objectContaining({ type: 'planning.cycle.detected', orgId: 'org1' }),
        { orgId: 'org1' }
      )
    })

    it('MUST support scope subscription by { orgId }', async () => {
      registerPlanningWs(ws, bus)
      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId: 'org2' }
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(ws.broadcastToChannel).toHaveBeenCalledWith('planning', expect.anything(), { orgId: 'org2' })
    })

    it('MUST only send updates to clients subscribed to the relevant orgId', async () => {
      registerPlanningWs(ws, bus)
      bus.emit({
        type: 'planning.graph.updated',
        timestamp: new Date().toISOString(),
        source: 'planning',
        payload: { orgId: 'org1' }
      })
      await new Promise((r) => setTimeout(r, 50))
      // Scope is passed — WsHandler is responsible for filtering by scope
      const call = (ws.broadcastToChannel as ReturnType<typeof vi.fn>).mock.calls[0]
      expect(call[2]).toEqual({ orgId: 'org1' })
    })
  })
})
