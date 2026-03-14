import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerOrgsChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-orgs-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

function subscribe(client: WsLike, channels: string[], scope?: Record<string, string>) {
  ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
    JSON.stringify({ type: 'subscribe', channels, scope })
  )
}

function getSentMessages(client: WsLike): Record<string, unknown>[] {
  return (client.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => {
      try {
        return JSON.parse(c[0] as string)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

describe('Orgs WS Channel', () => {
  it('registers orgs channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerOrgsChannel(ws, bus)
    expect(ws.getChannels()).toContain('orgs')
  })

  it('bridges org.created bus event to org.created WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerOrgsChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['orgs'])

    bus.emit({
      type: 'org.created',
      timestamp: new Date().toISOString(),
      source: 'orgs',
      payload: { orgId: 'org-1', name: 'Test Org' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'org.created')
    expect(msg).toBeDefined()
    expect(msg!.orgId).toBe('org-1')
    expect(msg!.name).toBe('Test Org')
  })

  it('bridges org.updated bus event to org.updated WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerOrgsChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['orgs'])

    bus.emit({
      type: 'org.updated',
      timestamp: new Date().toISOString(),
      source: 'orgs',
      payload: { orgId: 'org-1', name: 'Updated Org' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'org.updated')
    expect(msg).toBeDefined()
    expect(msg!.name).toBe('Updated Org')
  })

  it('bridges org.deleted bus event to org.deleted WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerOrgsChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['orgs'])

    bus.emit({
      type: 'org.deleted',
      timestamp: new Date().toISOString(),
      source: 'orgs',
      payload: { orgId: 'org-1' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'org.deleted')
    expect(msg).toBeDefined()
    expect(msg!.orgId).toBe('org-1')
  })

  it('only sends to subscribed clients', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerOrgsChannel(ws, bus)

    const client1 = mockWs()
    const client2 = mockWs()
    ws.handleConnection(client1, 'device-1')
    ws.handleConnection(client2, 'device-2')

    // Only client1 subscribes to orgs
    subscribe(client1, ['orgs'])

    bus.emit({
      type: 'org.created',
      timestamp: new Date().toISOString(),
      source: 'orgs',
      payload: { orgId: 'org-1', name: 'Test' }
    })

    expect(getSentMessages(client1).find((m) => m.type === 'org.created')).toBeDefined()
    expect(getSentMessages(client2).find((m) => m.type === 'org.created')).toBeUndefined()
  })
})
