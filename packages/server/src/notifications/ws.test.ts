import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@template/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerNotificationsChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-notif-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

function subscribeClient(ws: ReturnType<typeof createWsHandler>, client: WsLike, deviceId: string, channels: string[]) {
  ws.handleConnection(client, deviceId)
  // Simulate subscribe message
  const onMessage = (client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')
  if (onMessage) {
    const handler = onMessage[1] as (raw: string) => void
    handler(JSON.stringify({ type: 'subscribe', channels }))
  }
}

describe('Notifications WS Channel', () => {
  it('registers notifications channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerNotificationsChannel(ws, bus)
    expect(ws.getChannels()).toContain('notifications')
  })

  it('bridges notification.created bus event to notification.new WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerNotificationsChannel(ws, bus)

    const client = mockWs()
    subscribeClient(ws, client, 'device-1', ['notifications'])

    bus.emit({
      type: 'notification.created',
      timestamp: new Date().toISOString(),
      source: 'notifications',
      payload: { id: 'n1', title: 'Test', body: 'Hello', level: 'info' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const notifMsg = msgs.find((m: Record<string, unknown>) => m.type === 'notification.new')
    expect(notifMsg).toBeDefined()
    expect(notifMsg.id).toBe('n1')
    expect(notifMsg.title).toBe('Test')
    expect(notifMsg.body).toBe('Hello')
    expect(notifMsg.level).toBe('info')
  })

  it('bridges notification.read bus event to notification.read WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerNotificationsChannel(ws, bus)

    const client = mockWs()
    subscribeClient(ws, client, 'device-1', ['notifications'])

    bus.emit({
      type: 'notification.read',
      timestamp: new Date().toISOString(),
      source: 'notifications',
      payload: { id: 'n1' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const readMsg = msgs.find((m: Record<string, unknown>) => m.type === 'notification.read')
    expect(readMsg).toBeDefined()
    expect(readMsg.id).toBe('n1')
  })

  it('only sends to subscribed clients', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerNotificationsChannel(ws, bus)

    const subscribedClient = mockWs()
    const unsubscribedClient = mockWs()

    subscribeClient(ws, subscribedClient, 'device-1', ['notifications'])
    ws.handleConnection(unsubscribedClient, 'device-2')
    // device-2 is only auto-subscribed to 'status', not 'notifications'

    bus.emit({
      type: 'notification.created',
      timestamp: new Date().toISOString(),
      source: 'notifications',
      payload: { id: 'n1', title: 'Test', body: 'Hello', level: 'info' }
    })

    const subCalls = (subscribedClient.send as ReturnType<typeof vi.fn>).mock.calls
    const subMsgs = subCalls.map((c: unknown[]) => JSON.parse(c[0] as string))
    expect(subMsgs.some((m: Record<string, unknown>) => m.type === 'notification.new')).toBe(true)

    const unsubCalls = (unsubscribedClient.send as ReturnType<typeof vi.fn>).mock.calls
    const unsubMsgs = unsubCalls.map((c: unknown[]) => JSON.parse(c[0] as string))
    expect(unsubMsgs.some((m: Record<string, unknown>) => m.type === 'notification.new')).toBe(false)
  })
})
