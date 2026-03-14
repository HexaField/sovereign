import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerSchedulerChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-sched-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

function subscribeClient(ws: ReturnType<typeof createWsHandler>, client: WsLike, deviceId: string, channels: string[]) {
  ws.handleConnection(client, deviceId)
  const onMessage = (client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')
  if (onMessage) {
    const handler = onMessage[1] as (raw: string) => void
    handler(JSON.stringify({ type: 'subscribe', channels }))
  }
}

describe('Scheduler WS Channel', () => {
  it('registers scheduler channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerSchedulerChannel(ws, bus)
    expect(ws.getChannels()).toContain('scheduler')
  })

  it('bridges scheduler.job.started bus event to WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerSchedulerChannel(ws, bus)

    const client = mockWs()
    subscribeClient(ws, client, 'device-1', ['scheduler'])

    bus.emit({
      type: 'scheduler.job.started',
      timestamp: new Date().toISOString(),
      source: 'scheduler',
      payload: { jobId: 'j1', name: 'backup' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const msg = msgs.find((m: Record<string, unknown>) => m.type === 'scheduler.job.started')
    expect(msg).toBeDefined()
    expect(msg.jobId).toBe('j1')
  })

  it('bridges scheduler.job.completed bus event to WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerSchedulerChannel(ws, bus)

    const client = mockWs()
    subscribeClient(ws, client, 'device-1', ['scheduler'])

    bus.emit({
      type: 'scheduler.job.completed',
      timestamp: new Date().toISOString(),
      source: 'scheduler',
      payload: { jobId: 'j1', result: 'success' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const msg = msgs.find((m: Record<string, unknown>) => m.type === 'scheduler.job.completed')
    expect(msg).toBeDefined()
    expect(msg.jobId).toBe('j1')
  })

  it('bridges scheduler.job.failed bus event to WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerSchedulerChannel(ws, bus)

    const client = mockWs()
    subscribeClient(ws, client, 'device-1', ['scheduler'])

    bus.emit({
      type: 'scheduler.job.failed',
      timestamp: new Date().toISOString(),
      source: 'scheduler',
      payload: { jobId: 'j1', error: 'timeout' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const msg = msgs.find((m: Record<string, unknown>) => m.type === 'scheduler.job.failed')
    expect(msg).toBeDefined()
    expect(msg.jobId).toBe('j1')
    expect(msg.error).toBe('timeout')
  })

  it('only sends to subscribed clients', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerSchedulerChannel(ws, bus)

    const subscribedClient = mockWs()
    const unsubscribedClient = mockWs()

    subscribeClient(ws, subscribedClient, 'device-1', ['scheduler'])
    ws.handleConnection(unsubscribedClient, 'device-2')

    bus.emit({
      type: 'scheduler.job.started',
      timestamp: new Date().toISOString(),
      source: 'scheduler',
      payload: { jobId: 'j1', name: 'backup' }
    })

    const subCalls = (subscribedClient.send as ReturnType<typeof vi.fn>).mock.calls
    const subMsgs = subCalls.map((c: unknown[]) => JSON.parse(c[0] as string))
    expect(subMsgs.some((m: Record<string, unknown>) => m.type === 'scheduler.job.started')).toBe(true)

    const unsubCalls = (unsubscribedClient.send as ReturnType<typeof vi.fn>).mock.calls
    const unsubMsgs = unsubCalls.map((c: unknown[]) => JSON.parse(c[0] as string))
    expect(unsubMsgs.some((m: Record<string, unknown>) => m.type === 'scheduler.job.started')).toBe(false)
  })
})
