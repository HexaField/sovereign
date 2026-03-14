import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerMeetingsChannel } from './ws.js'
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

describe('§8.7.1 Meetings WS Channel', () => {
  let bus: ReturnType<typeof createMockBus>
  let ws: ReturnType<typeof createMockWs>

  beforeEach(() => {
    bus = createMockBus()
    ws = createMockWs()
    registerMeetingsChannel(ws, bus)
  })

  it('§8.7.1 MUST register a meetings WS channel', () => {
    expect(ws.registerChannel).toHaveBeenCalledWith(
      'meetings',
      expect.objectContaining({
        serverMessages: expect.arrayContaining(['meeting.created', 'meeting.updated', 'meeting.deleted'])
      })
    )
  })

  it('§8.7.1 MUST broadcast meeting.created with full Meeting payload', () => {
    bus.fire({
      type: 'meeting.created',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'meetings',
      payload: { orgId: 'org1', id: 'm1', title: 'Test' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith(
      'meetings',
      expect.objectContaining({ type: 'meeting.created', orgId: 'org1', id: 'm1' }),
      { orgId: 'org1' }
    )
  })

  it('§8.7.1 MUST broadcast meeting.updated with full Meeting payload on any change', () => {
    bus.fire({
      type: 'meeting.updated',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'meetings',
      payload: { orgId: 'org1', id: 'm1', changes: ['title'] }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith(
      'meetings',
      expect.objectContaining({ type: 'meeting.updated', id: 'm1' }),
      { orgId: 'org1' }
    )
  })

  it('§8.7.1 MUST broadcast meeting.deleted with { id, orgId }', () => {
    bus.fire({
      type: 'meeting.deleted',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'meetings',
      payload: { orgId: 'org1', id: 'm1' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith(
      'meetings',
      expect.objectContaining({ type: 'meeting.deleted', orgId: 'org1', id: 'm1' }),
      { orgId: 'org1' }
    )
  })

  it('§8.7.1 MUST scope by orgId', () => {
    bus.fire({
      type: 'meeting.created',
      timestamp: '2026-01-01T00:00:00Z',
      source: 'meetings',
      payload: { orgId: 'org-specific', id: 'm1', title: 'Scoped' }
    })
    expect(ws.broadcastToChannel).toHaveBeenCalledWith('meetings', expect.anything(), { orgId: 'org-specific' })
  })
})
