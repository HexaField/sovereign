import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentBackend, ParsedTurn } from '@sovereign/core'
import { createBackendEmitter, createSessionsRegistry } from '@sovereign/primitives'
import { createBackend } from '../factory.js'
import { createHarnessBackend } from './backend.js'
import type { HarnessRunner, HarnessRunRecord } from './runner.js'

const KEY = 'harness-00000000-0000-4000-8000-00000000000a'
const DONE = 'harness-00000000-0000-4000-8000-00000000000b'

function record(over: Partial<HarnessRunRecord>): HarnessRunRecord {
  return {
    sessionKey: KEY,
    parentKey: 'thread-1',
    label: 'fix bug',
    harness: 'devin',
    task: 'Fix the bug.',
    cwd: '/work/repo',
    model: 'swe-2',
    startedAt: 1000,
    adapter: 'devin',
    status: 'working',
    ...over
  }
}

const turn = (role: ParsedTurn['role'], content: string, timestamp: number): ParsedTurn => ({
  role,
  content,
  timestamp,
  workItems: [],
  thinkingBlocks: []
})

function fakeRunner() {
  const emitter = createBackendEmitter('harness')
  const stopped: string[] = []
  const records = [record({}), record({ sessionKey: DONE, status: 'completed', endedAt: 5000, parentKey: 'thread-2' })]
  const runner = {
    records: (parent?: string) => records.filter((r) => !parent || r.parentKey === parent),
    record: (key: string) => records.find((r) => r.sessionKey === key) ?? null,
    history: (key: string) =>
      records.some((r) => r.sessionKey === key)
        ? [turn('user', 'Fix the bug.', 1000), turn('assistant', 'a', 2000), turn('assistant', 'b', 3000)]
        : null,
    has: (key: string) => key === KEY,
    stop: async (key: string) => {
      stopped.push(key)
    },
    on: emitter.on,
    off: emitter.off
  } as unknown as HarnessRunner
  return { runner, stopped, emit: emitter.emit }
}

describe('createHarnessBackend', () => {
  it('owns harness keys only', () => {
    const b = createHarnessBackend(fakeRunner().runner)
    expect(b.kind).toBe('harness')
    expect(b.ownsSession?.(KEY)).toBe(true)
    expect(b.ownsSession?.('thread-1')).toBe(false)
  })

  it("serves a run's turns, paged like any backend's history", async () => {
    const b = createHarnessBackend(fakeRunner().runner)
    expect((await b.getHistory(KEY)).turns.map((t) => t.content)).toEqual(['Fix the bug.', 'a', 'b'])
    expect(await b.getHistory(KEY, { limit: 2 })).toMatchObject({ hasMore: true, oldestTimestamp: 2000 })
    expect((await b.getHistory(KEY, { before: 3000 })).turns.map((t) => t.content)).toEqual(['Fix the bug.', 'a'])
    expect(await b.getHistory('harness-unknown')).toEqual({ turns: [], hasMore: false, oldestTimestamp: undefined })
  })

  it('lists runs as subagent sessions under their parent: working while running, idle once ended', async () => {
    const b = createHarnessBackend(fakeRunner().runner)
    expect(await b.listSessions({ kind: 'thread' })).toEqual([])
    const sessions = await b.listSessions({ kind: 'subagent' })
    expect(sessions).toEqual([
      expect.objectContaining({
        key: KEY,
        kind: 'subagent',
        agentStatus: 'working',
        parentKey: 'thread-1',
        task: 'Fix the bug.',
        cwd: '/work/repo',
        startedAt: 1000
      }),
      expect.objectContaining({ key: DONE, agentStatus: 'idle', lastActivity: 5000 })
    ])
    // A legacy compound parent key names the same thread.
    expect((await b.listSubagents('agent:main:thread:thread-1')).map((s) => [s.sessionKey, s.status])).toEqual([
      [KEY, 'working']
    ])
    expect(await b.getSessionMeta(KEY)).toMatchObject({ model: 'swe-2', label: 'fix bug', backendKind: 'harness' })
    expect(await b.getSessionMeta('harness-unknown')).toBeNull()
  })

  it('stops a running run on abort, and refuses messages with a reason', async () => {
    const { runner, stopped } = fakeRunner()
    const b = createHarnessBackend(runner)
    await b.abort(KEY)
    await b.abort(DONE)
    expect(stopped).toEqual([KEY])
    await expect(b.sendMessage(KEY, 'hi')).rejects.toThrow(/harness run: it takes no messages/)
  })

  it('routing sends harness keys to it and relays its events', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-backend-test-'))
    try {
      const { runner, emit } = fakeRunner()
      const harness = createHarnessBackend(runner)
      const own = createBackendEmitter('claude-code')
      const main = { ...harness, kind: 'claude-code', ownsSession: undefined, on: own.on, off: own.off } as AgentBackend
      const routing = createBackend({
        enabled: ['claude-code'],
        default: 'claude-code',
        registry: createSessionsRegistry(dataDir, { debounceMs: 0 }),
        factories: { 'claude-code': () => main },
        owners: [harness]
      })
      expect(routing.forSession(KEY)).toBe(harness)
      expect(routing.forSession('thread-1')).toBe(main)
      const seen: string[] = []
      routing.on('subagent.completed', (e) => seen.push(`${e.childKey} ${e.backendKind}`))
      emit('subagent.completed', { parentKey: 'thread-1', childKey: KEY, result: 'ok', parentMessage: 'm' })
      expect(seen).toEqual([`${KEY} harness`])
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
