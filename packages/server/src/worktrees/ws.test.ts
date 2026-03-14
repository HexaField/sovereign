import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createWsHandler, type WsLike } from '../ws/handler.js'
import { registerWorktreesChannel } from './ws.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-worktrees-ws-test-'))
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

describe('Worktrees WS Channel', () => {
  it('registers worktrees channel with correct server message types', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerWorktreesChannel(ws, bus)
    expect(ws.getChannels()).toContain('worktrees')
  })

  it('bridges worktree.created bus event to worktree.update WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerWorktreesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['worktrees'], { projectId: 'proj-1' })

    bus.emit({
      type: 'worktree.created',
      timestamp: new Date().toISOString(),
      source: 'worktrees',
      payload: { projectId: 'proj-1', worktreePath: '/tmp/wt1' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'worktree.update')
    expect(msg).toBeDefined()
    expect(msg!.kind).toBe('created')
    expect(msg!.projectId).toBe('proj-1')
  })

  it('bridges worktree.removed bus event to worktree.update WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerWorktreesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['worktrees'], { projectId: 'proj-1' })

    bus.emit({
      type: 'worktree.removed',
      timestamp: new Date().toISOString(),
      source: 'worktrees',
      payload: { projectId: 'proj-1', worktreePath: '/tmp/wt1' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'worktree.update')
    expect(msg).toBeDefined()
    expect(msg!.kind).toBe('removed')
  })

  it('bridges worktree.stale bus event to worktree.stale WS message', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerWorktreesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['worktrees'], { projectId: 'proj-1' })

    bus.emit({
      type: 'worktree.stale',
      timestamp: new Date().toISOString(),
      source: 'worktrees',
      payload: { projectId: 'proj-1', worktreePath: '/tmp/wt1' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'worktree.stale')
    expect(msg).toBeDefined()
    expect(msg!.projectId).toBe('proj-1')
  })

  it('scopes messages by projectId', () => {
    const bus = createEventBus(tmpDir())
    const ws = createWsHandler(bus)
    registerWorktreesChannel(ws, bus)

    const client = mockWs()
    ws.handleConnection(client, 'device-1')
    subscribe(client, ['worktrees'], { projectId: 'proj-1' })

    bus.emit({
      type: 'worktree.created',
      timestamp: new Date().toISOString(),
      source: 'worktrees',
      payload: { projectId: 'proj-2', worktreePath: '/tmp/wt2' }
    })

    const msg = getSentMessages(client).find((m) => m.type === 'worktree.update')
    expect(msg).toBeUndefined()
  })
})
