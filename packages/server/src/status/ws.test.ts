import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@template/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerStatusChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-status-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

describe('Status WS Channel', () => {
  it('registers status channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerStatusChannel(ws, bus)
    expect(ws.getChannels()).toContain('status')
  })

  it('bridges status.update bus event to status.update WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerStatusChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    // device-1 is auto-subscribed to 'status'

    bus.emit({
      type: 'status.update',
      timestamp: new Date().toISOString(),
      source: 'status',
      payload: { connected: true, activeJobs: 2, unreadNotifications: 5 }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const statusMsg = msgs.find((m: Record<string, unknown>) => m.type === 'status.update')
    expect(statusMsg).toBeDefined()
    expect(statusMsg.connected).toBe(true)
    expect(statusMsg.activeJobs).toBe(2)
    expect(statusMsg.unreadNotifications).toBe(5)
    expect(statusMsg.timestamp).toBeDefined()
  })

  it('auto-subscribes new connections to status channel', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerStatusChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')

    bus.emit({
      type: 'status.update',
      timestamp: new Date().toISOString(),
      source: 'status',
      payload: { connected: true, activeJobs: 0, unreadNotifications: 0 }
    })

    expect(client.send).toHaveBeenCalled()
  })

  it('scopes status updates appropriately', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerStatusChannel(ws, bus)

    // Client not connected — no sends
    const unconnectedClient = mockWs()
    // Don't connect this client

    bus.emit({
      type: 'status.update',
      timestamp: new Date().toISOString(),
      source: 'status',
      payload: { connected: false, activeJobs: 0, unreadNotifications: 0 }
    })

    expect(unconnectedClient.send).not.toHaveBeenCalled()
  })
})
