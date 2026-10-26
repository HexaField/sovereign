// The bus events the timeline reads from chat: a turn's start and end with
// its origin, subagent lifecycle with the parent thread, compactions and
// recycles. Made-up threads only.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveSessionKey, type AgentBackend, type BusEvent, type EventBus } from '@sovereign/core'
import type { ThreadManager } from '@sovereign/threads'
import { createChatModule, type ChatModule } from './chat.js'

function createBus(): EventBus & { events: BusEvent[] } {
  const handlers = new Map<string, Array<(e: BusEvent) => void>>()
  const events: BusEvent[] = []
  return {
    events,
    emit: (event: BusEvent) => {
      events.push(event)
      for (const fn of handlers.get(event.type) ?? []) fn(event)
    },
    on: (pattern: string, handler: (e: BusEvent) => void) => {
      handlers.set(pattern, [...(handlers.get(pattern) ?? []), handler])
      return () =>
        handlers.set(
          pattern,
          (handlers.get(pattern) ?? []).filter((h) => h !== handler)
        )
    },
    once: () => () => {},
    replay: vi.fn() as never,
    history: () => []
  }
}

function createBackend() {
  const handlers = new Map<string, Array<(data: unknown) => void>>()
  const backend = {
    kind: 'claude-code',
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    status: () => 'connected',
    sendMessage: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => 's'),
    getHistory: vi.fn(async () => ({ turns: [], hasMore: false })),
    getFullHistory: vi.fn(async () => []),
    on: (event: string, h: (data: unknown) => void) => void handlers.set(event, [...(handlers.get(event) ?? []), h]),
    off: vi.fn(),
    capabilities: () => ({}),
    listSessions: vi.fn(async () => []),
    listSubagents: vi.fn(async () => []),
    getSessionMeta: vi.fn(async () => null),
    setSessionModel: vi.fn(async () => {}),
    listAvailableModels: vi.fn(async () => ({ models: [], defaultModel: null })),
    getContextBudget: vi.fn(async () => null)
  }
  const fire = (event: string, data: unknown) => {
    for (const h of handlers.get(event) ?? []) h(data)
  }
  return { backend: backend as unknown as AgentBackend, fire }
}

function createThreads(ids: string[]): ThreadManager {
  const threads = new Map(ids.map((id) => [id, { id, label: `Label ${id}`, archived: false }]))
  return {
    get: (id: string) => threads.get(id),
    resolve: (id: string) => threads.get(id),
    list: () => [...threads.values()],
    touch: () => {}
  } as unknown as ThreadManager
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('chat → timeline bus events', () => {
  let dataDir: string
  let bus: ReturnType<typeof createBus>
  let fire: (event: string, data: unknown) => void
  let chat: ChatModule
  const T = 'thread-a'
  const key = deriveSessionKey(T)
  const of = (type: string) =>
    bus.events.filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>)

  function start() {
    // The thread's session is known from an earlier run, as after a restart.
    fs.mkdirSync(path.join(dataDir, 'chat'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'chat', 'session-map.json'), JSON.stringify({ [T]: key }))
    const b = createBackend()
    fire = b.fire
    chat = createChatModule(bus, b.backend, createThreads([T, 'thread-b']), { dataDir })
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-turns-'))
    bus = createBus()
  })
  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('a user send starts a turn with its origin; the idle ends it with the duration', async () => {
    start()
    await chat.handleSend(T, 'Fix the gear ratio', undefined, { origin: { modality: 'voice' } })
    await flush()
    expect(of('chat.message.sent')[0]).toMatchObject({ threadId: T, via: 'user' })
    expect(of('chat.turn.started')).toEqual([
      { threadId: T, via: 'user', modality: 'voice', preview: 'Fix the gear ratio' }
    ])
    fire('chat.status', { sessionKey: key, status: 'working' })
    fire('chat.status', { sessionKey: key, status: 'thinking' })
    expect(of('chat.turn.started')).toHaveLength(1)
    fire('chat.status', { sessionKey: key, status: 'idle' })
    fire('chat.status', { sessionKey: key, status: 'idle' })
    const ended = of('chat.turn.ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ threadId: T, via: 'user' })
    expect(typeof ended[0]!.durationMs).toBe('number')
  })

  it.each([
    [{ synthRole: 'system' as const, via: 'cron' as const }, 'cron'],
    [{ synthRole: 'system' as const, via: 'rethink' as const }, 'rethink'],
    [{ synthRole: 'system' as const, via: 'subagent' as const }, 'subagent'],
    [{ origin: { modality: 'text' as const }, via: 'agent' as const }, 'agent'],
    [{ synthRole: 'system' as const }, 'system'],
    [{ origin: { modality: 'ad4m' as const } }, 'system'],
    [{ origin: { modality: 'cron' as const } }, 'cron'],
    [undefined, 'user']
  ])('send options %j → origin %s', async (opts, via) => {
    start()
    await chat.handleSend(T, 'hello', undefined, opts)
    await flush()
    expect(of('chat.turn.started')[0]).toMatchObject({ threadId: T, via })
    expect(of('chat.message.sent')[0]).toMatchObject({ via })
  })

  it('a turn nobody queued (a resume, a session nudged directly) starts as system', () => {
    start()
    fire('chat.status', { sessionKey: key, status: 'working' })
    expect(of('chat.turn.started')).toEqual([{ threadId: T, via: 'system' }])
  })

  it('a sessions_send into the session marks its next turn as started by another thread', () => {
    start()
    bus.emit({
      type: 'chat.message.injected',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { sessionKey: key, via: 'agent', preview: 'Please review' }
    })
    fire('chat.status', { sessionKey: key, status: 'working' })
    expect(of('chat.turn.started')).toEqual([{ threadId: T, via: 'agent', preview: 'Please review' }])
  })

  it('the local-llm order (assistant turn, then the synthesized idle) ends the turn once', async () => {
    start()
    await chat.handleSend(T, 'hi', undefined, undefined)
    await flush()
    fire('chat.turn', {
      sessionKey: key,
      turn: { role: 'assistant', content: 'hello', timestamp: Date.now(), workItems: [], thinkingBlocks: [] }
    })
    expect(of('chat.turn.ended')).toHaveLength(1)
  })

  it('subagents: spawned, done and failed reach the bus with the parent thread; their own turns do not', () => {
    start()
    fire('subagent.spawned', {
      parentKey: key,
      childKey: 'child-1',
      task: 'Port the parser to the new API',
      label: 'Port parser'
    })
    fire('chat.status', { sessionKey: 'child-1', status: 'working' })
    fire('chat.status', { sessionKey: 'child-1', status: 'idle' })
    fire('subagent.completed', {
      parentKey: key,
      childKey: 'child-1',
      result: 'long result text',
      durationMs: 5000,
      parentMessage: 'msg'
    })
    fire('subagent.failed', { parentKey: key, childKey: 'child-2', error: 'stopped by the parent', ended: 'stopped' })
    expect(of('subagent.spawned')).toEqual([
      { threadId: T, parentKey: key, childKey: 'child-1', label: 'Port parser', task: 'Port the parser to the new API' }
    ])
    expect(of('subagent.completed')).toEqual([
      { threadId: T, parentKey: key, childKey: 'child-1', label: 'Port parser', durationMs: 5000 }
    ])
    expect(of('subagent.failed')).toEqual([
      { threadId: T, parentKey: key, childKey: 'child-2', error: 'stopped by the parent', ended: 'stopped' }
    ])
    expect(of('chat.turn.started')).toEqual([])
    expect(JSON.stringify(bus.events)).not.toContain('long result text')
  })

  it('a compaction ending and a recycle reach the bus with the thread', () => {
    start()
    fire('chat.compacting', { sessionKey: key, active: true })
    fire('chat.compacting', { sessionKey: key, active: false })
    fire('session.recycled', { sessionKey: key, preTokens: 600_000, postTokens: 200_000, method: 'auto-recycle' })
    expect(of('chat.compacted')).toEqual([{ threadId: T }])
    expect(of('chat.recycled')).toEqual([
      { threadId: T, preTokens: 600_000, postTokens: 200_000, method: 'auto-recycle' }
    ])
  })

  it('the stuck-status reset ends the turn as stuck', () => {
    vi.useFakeTimers()
    start()
    fire('chat.status', { sessionKey: key, status: 'working' })
    vi.advanceTimersByTime(31 * 60_000)
    expect(of('chat.turn.ended')).toEqual([expect.objectContaining({ threadId: T, via: 'system', reason: 'stuck' })])
  })
})
