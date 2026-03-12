import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@template/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerGitChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-git-ws-test-'))
}

function mockWs(): WsLike {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() }
}

describe('Git WS Channel', () => {
  it('registers git channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerGitChannel(ws, bus)
    expect(ws.getChannels()).toContain('git')
  })

  it('bridges git.status.changed bus event to git.status WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerGitChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['git'], scope: { projectId: 'proj-1' } })
    )

    bus.emit({
      type: 'git.status.changed',
      timestamp: new Date().toISOString(),
      source: 'git',
      payload: { projectId: 'proj-1', branch: 'main', dirty: true }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    const gitMsg = msgs.find((m: Record<string, unknown>) => m.type === 'git.status')
    expect(gitMsg).toBeDefined()
    expect(gitMsg.projectId).toBe('proj-1')
    expect(gitMsg.branch).toBe('main')
  })

  it('scopes messages by projectId', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerGitChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    ;(client.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['git'], scope: { projectId: 'proj-1' } })
    )

    bus.emit({
      type: 'git.status.changed',
      timestamp: new Date().toISOString(),
      source: 'git',
      payload: { projectId: 'proj-2', branch: 'dev' }
    })

    const calls = (client.send as ReturnType<typeof vi.fn>).mock.calls
    const msgs = calls.map((c: unknown[]) => JSON.parse(c[0] as string))
    expect(msgs.find((m: Record<string, unknown>) => m.type === 'git.status')).toBeUndefined()
  })

  it('only sends to clients subscribed with matching project scope', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerGitChannel(ws, bus)

    const client1 = mockWs()
    const client2 = mockWs()
    ws.handleConnection(client1, 'device-1')
    ws.handleConnection(client2, 'device-2')

    ;(client1.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['git'], scope: { projectId: 'proj-1' } })
    )
    ;(client2.on as ReturnType<typeof vi.fn>).mock.calls.find((c: unknown[]) => c[0] === 'message')?.[1](
      JSON.stringify({ type: 'subscribe', channels: ['git'], scope: { projectId: 'proj-2' } })
    )

    bus.emit({
      type: 'git.status.changed',
      timestamp: new Date().toISOString(),
      source: 'git',
      payload: { projectId: 'proj-1', branch: 'main' }
    })

    const msgs1 = (client1.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
      JSON.parse(c[0] as string)
    )
    const msgs2 = (client2.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) =>
      JSON.parse(c[0] as string)
    )

    expect(msgs1.find((m: Record<string, unknown>) => m.type === 'git.status')).toBeDefined()
    expect(msgs2.find((m: Record<string, unknown>) => m.type === 'git.status')).toBeUndefined()
  })
})
