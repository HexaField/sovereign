import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@template/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerFilesChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-files-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

describe('Files WS Channel', () => {
  it('registers files channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerFilesChannel(ws, bus)
    expect(ws.getChannels()).toContain('files')
  })

  it('bridges file.created bus event to file.changed WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerFilesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    // Subscribe to files channel with project scope
    ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { projectId: 'proj-1' } })
    )

    bus.emit({
      type: 'file.created',
      timestamp: new Date().toISOString(),
      source: 'files',
      payload: { projectId: 'proj-1', filePath: '/foo.txt' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const fileMsg = msgs.find((m: Record<string, unknown>) => m.type === 'file.changed')
    expect(fileMsg).toBeDefined()
    expect(fileMsg.kind).toBe('created')
    expect(fileMsg.projectId).toBe('proj-1')
    expect(fileMsg.filePath).toBe('/foo.txt')
  })

  it('bridges file.deleted bus event to file.changed WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerFilesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { projectId: 'proj-1' } })
    )

    bus.emit({
      type: 'file.deleted',
      timestamp: new Date().toISOString(),
      source: 'files',
      payload: { projectId: 'proj-1', filePath: '/bar.txt' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const fileMsg = msgs.find((m: Record<string, unknown>) => m.type === 'file.changed')
    expect(fileMsg).toBeDefined()
    expect(fileMsg.kind).toBe('deleted')
  })

  it('scopes messages by projectId', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerFilesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { projectId: 'proj-1' } })
    )

    // Emit for a different project
    bus.emit({
      type: 'file.created',
      timestamp: new Date().toISOString(),
      source: 'files',
      payload: { projectId: 'proj-2', filePath: '/other.txt' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const fileMsg = msgs.find((m: Record<string, unknown>) => m.type === 'file.changed')
    expect(fileMsg).toBeUndefined()
  })

  it('only sends to clients subscribed with matching project scope', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerFilesChannel(ws, bus)

    const client1 = mockWs()
    const client2 = mockWs()
    ws.handleConnection(client1, 'device-1')
    ws.handleConnection(client2, 'device-2')

    // client1 subscribes to proj-1
    ;(client1.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { projectId: 'proj-1' } })
    )
    // client2 subscribes to proj-2
    ;(client2.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['files'], scope: { projectId: 'proj-2' } })
    )

    bus.emit({
      type: 'file.created',
      timestamp: new Date().toISOString(),
      source: 'files',
      payload: { projectId: 'proj-1', filePath: '/foo.txt' }
    })

    const msgs1 = (client1.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
      JSON.parse(c[0] as string)
    )
    const msgs2 = (client2.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
      JSON.parse(c[0] as string)
    )

    expect(msgs1.find((m: Record<string, unknown>) => m.type === 'file.changed')).toBeDefined()
    expect(msgs2.find((m: Record<string, unknown>) => m.type === 'file.changed')).toBeUndefined()
  })
})
