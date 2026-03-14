import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerRecordingsChannel } from './ws.js'
import type { EventBus, BusEvent, BusHandler } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'

function createMockBus(): EventBus & { fire(event: BusEvent): void } {
  const handlers = new Map<string, BusHandler[]>()
  return {
    emit: vi.fn(),
    on(pattern: string, handler: BusHandler) {
      if (!handlers.has(pattern)) handlers.set(pattern, [])
      handlers.get(pattern)!.push(handler)
      return () => {}
    },
    once: vi.fn().mockReturnValue(() => {}),
    replay: vi.fn() as any,
    history: vi.fn().mockReturnValue([]),
    fire(event: BusEvent) {
      const fns = handlers.get(event.type) ?? []
      for (const fn of fns) fn(event)
    }
  }
}

function createMockWs(): WsHandler {
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

describe('§8.7.2 Recordings WS Channel', () => {
  let bus: ReturnType<typeof createMockBus>
  let ws: ReturnType<typeof createMockWs>

  beforeEach(() => {
    bus = createMockBus()
    ws = createMockWs()
    registerRecordingsChannel(ws, bus)
  })

  it('§8.7.2 MUST register a recordings WS channel', () => {
    expect(ws.registerChannel).toHaveBeenCalledWith(
      'recordings',
      expect.objectContaining({
        serverMessages: expect.arrayContaining(['recording.created', 'recording.updated', 'recording.deleted'])
      })
    )
  })

  it('§8.7.2 MUST broadcast recording.created with RecordingMeta payload', () => {
    bus.fire({
      type: 'recording.created',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'recordings',
      payload: { orgId: 'org1', id: 'r1', name: 'Test' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith(
      'recordings',
      expect.objectContaining({ type: 'recording.created', id: 'r1' }),
      { orgId: 'org1' }
    )
  })

  it('§8.7.2 MUST broadcast recording.updated with RecordingMeta payload', () => {
    bus.fire({
      type: 'recording.updated',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'recordings',
      payload: { orgId: 'org1', id: 'r1', transcriptStatus: 'completed' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith(
      'recordings',
      expect.objectContaining({ type: 'recording.updated', id: 'r1' }),
      { orgId: 'org1' }
    )
  })

  it('§8.7.2 MUST broadcast recording.deleted with { id, orgId }', () => {
    bus.fire({
      type: 'recording.deleted',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'recordings',
      payload: { orgId: 'org1', id: 'r1' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith(
      'recordings',
      expect.objectContaining({ type: 'recording.deleted', orgId: 'org1', id: 'r1' }),
      { orgId: 'org1' }
    )
  })

  it('§8.7.2 MUST scope by orgId', () => {
    bus.fire({
      type: 'recording.created',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'recordings',
      payload: { orgId: 'org-scoped', id: 'r1' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith('recordings', expect.anything(), { orgId: 'org-scoped' })
  })
})
