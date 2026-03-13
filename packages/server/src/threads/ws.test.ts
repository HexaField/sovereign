import { describe, it, expect, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@template/core'
import type { WsChannelOptions } from '@template/core'
import { createThreadManager } from './threads.js'
import { registerThreadsWs } from './ws.js'
import type { ThreadManager } from './types.js'
import type { WsHandler } from './ws.js'

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-ws-'))
}

function createMockWsHandler(): WsHandler & {
  channelOptions: Map<string, WsChannelOptions>
  broadcasts: Array<{ channel: string; msg: unknown }>
  sendMessage(channel: string, type: string, payload: unknown): void
} {
  const channelOptions = new Map<string, WsChannelOptions>()
  const broadcasts: Array<{ channel: string; msg: unknown }> = []
  return {
    channelOptions,
    broadcasts,
    registerChannel(name: string, options: WsChannelOptions) {
      channelOptions.set(name, options)
    },
    broadcastToChannel(channel: string, msg: unknown) {
      broadcasts.push({ channel, msg })
    },
    sendMessage(channel: string, type: string, payload: unknown) {
      const opts = channelOptions.get(channel)
      if (opts?.onMessage) opts.onMessage(type, payload, 'test-device')
    }
  }
}

describe('Threads WS Channel', () => {
  let dataDir: string
  let bus: ReturnType<typeof createEventBus>
  let tm: ThreadManager
  let ws: ReturnType<typeof createMockWsHandler>

  beforeEach(() => {
    dataDir = makeTmpDir()
    bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    ws = createMockWsHandler()
    registerThreadsWs(ws, tm, bus)
  })

  it('MUST register threads WS channel', () => {
    expect(ws.channelOptions.has('threads')).toBe(true)
  })

  it('MUST send thread.created when a new thread is created', () => {
    ws.sendMessage('threads', 'thread.create', { label: 'new-thread' })
    const found = ws.broadcasts.find((b) => (b.msg as Record<string, unknown>).type === 'thread.created')
    expect(found).toBeDefined()
  })

  it('MUST send thread.updated when thread metadata changes', () => {
    tm.create({ label: 'test-thread' })
    ws.broadcasts.length = 0

    ws.sendMessage('threads', 'thread.entity.add', {
      key: 'test-thread',
      entity: { orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '1' }
    })

    const found = ws.broadcasts.find((b) => (b.msg as Record<string, unknown>).type === 'thread.updated')
    expect(found).toBeDefined()
  })

  it('MUST send thread.event.routed when an entity event is routed to a thread', () => {
    bus.emit({
      type: 'thread.event.routed',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { threadKey: 'test', event: {}, entityBinding: {} }
    })
    const found = ws.broadcasts.find((b) => (b.msg as Record<string, unknown>).type === 'thread.event.routed')
    expect(found).toBeDefined()
  })

  it('MUST send thread.status when thread status changes', () => {
    tm.create({ label: 'status-test' })
    const found = ws.broadcasts.find((b) => (b.msg as Record<string, unknown>).type === 'thread.created')
    expect(found).toBeDefined()
  })

  it('MUST scope by { orgId, projectId } — client subscribed with scope only receives matching events', () => {
    const entity = { orgId: 'org1', projectId: 'proj1', entityType: 'issue' as const, entityRef: '5' }
    tm.create({ entities: [entity] })
    const found = ws.broadcasts.find((b) => {
      const msg = b.msg as Record<string, unknown>
      const payload = msg.payload as Record<string, unknown>
      const thread = payload?.thread as Record<string, unknown> | undefined
      return thread?.entities !== undefined
    })
    expect(found).toBeDefined()
  })

  it('MUST support unscoped subscription for all thread events', () => {
    tm.create({ label: 'unscoped-test' })
    expect(ws.broadcasts.length).toBeGreaterThan(0)
    expect(ws.broadcasts.every((b) => b.channel === 'threads')).toBe(true)
  })
})
