import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActiveSessions } from './active-sessions.js'
import { drainActiveSessions, countDraining } from './drain-active-sessions.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function newActive() {
  return createActiveSessions({ dataDir: tmpDir })
}

function upsertWorking(as: ReturnType<typeof newActive>, sessionKey: string) {
  as.upsert({
    sessionKey,
    threadKey: sessionKey,
    backendKind: 'claude-code',
    backendSessionId: 'u',
    agentStatus: 'working',
    lastTransitionAt: Date.now()
  })
}

describe('countDraining', () => {
  it('is 0 for an empty registry', () => {
    expect(countDraining(newActive())).toBe(0)
  })

  it('counts working + thinking sessions', () => {
    const as = newActive()
    upsertWorking(as, 'a')
    as.upsert({
      sessionKey: 'b',
      threadKey: 'b',
      backendKind: 'claude-code',
      backendSessionId: 'u',
      agentStatus: 'thinking',
      lastTransitionAt: Date.now()
    })
    expect(countDraining(as)).toBe(2)
  })

  it('excludes sessions with pendingToolAwait', () => {
    const as = newActive()
    upsertWorking(as, 'a')
    upsertWorking(as, 'b')
    as.setPendingToolAwait('a', { toolName: 'AskUserQuestion', toolCallId: 't1' })
    expect(countDraining(as)).toBe(1)
  })
})

describe('drainActiveSessions', () => {
  it('returns immediately when nothing is working', async () => {
    const as = newActive()
    const start = Date.now()
    const res = await drainActiveSessions({ activeSessions: as, timeoutMs: 5_000 })
    expect(res.leftWorking).toBe(0)
    expect(res.timedOut).toBe(false)
    // Fake clock isn't wired in this case, so we just check it didn't burn
    // through the full timeout.
    expect(Date.now() - start).toBeLessThan(1_000)
  })

  it('waits for working sessions to reach idle then returns cleanly', async () => {
    const as = newActive()
    upsertWorking(as, 'a')
    upsertWorking(as, 'b')

    // Injected sleep: on the 2nd tick, drop 'a' from the registry; on the
    // 3rd, drop 'b'. Deterministic — no real timers.
    let tick = 0
    const res = await drainActiveSessions({
      activeSessions: as,
      timeoutMs: 10_000,
      pollMs: 1,
      sleep: async () => {
        tick++
        if (tick === 1) as.remove('a')
        if (tick === 2) as.remove('b')
      }
    })
    expect(res.leftWorking).toBe(0)
    expect(res.timedOut).toBe(false)
  })

  it('times out cleanly when a session never drains', async () => {
    const as = newActive()
    upsertWorking(as, 'a')

    // Fake clock so the loop hits the timeout after 3 sleeps without a
    // real 100ms wait.
    let now = 0
    const res = await drainActiveSessions({
      activeSessions: as,
      timeoutMs: 100,
      pollMs: 40,
      sleep: async () => {
        now += 40
      },
      now: () => now
    })
    expect(res.leftWorking).toBe(1)
    expect(res.timedOut).toBe(true)
    // Entry remains — resume orchestrator picks it up on next boot.
    expect(as.list()).toHaveLength(1)
  })

  it('ignores pendingToolAwait sessions in the wait — they never drain on their own', async () => {
    const as = newActive()
    upsertWorking(as, 'a')
    as.setPendingToolAwait('a', { toolName: 'AskUserQuestion', toolCallId: 't1' })
    const res = await drainActiveSessions({ activeSessions: as, timeoutMs: 5_000 })
    // Should return in the first poll iteration because countDraining sees 0.
    expect(res.leftWorking).toBe(0)
    expect(res.timedOut).toBe(false)
  })

  it('emits log lines when the working count changes', async () => {
    const as = newActive()
    upsertWorking(as, 'a')
    upsertWorking(as, 'b')
    const logs: string[] = []
    let tick = 0
    await drainActiveSessions({
      activeSessions: as,
      timeoutMs: 10_000,
      pollMs: 1,
      log: (msg) => logs.push(msg),
      sleep: async () => {
        tick++
        if (tick === 1) as.remove('a')
        if (tick === 2) as.remove('b')
      }
    })
    // First log line reports the initial count; then a "1 still working"
    // when 'a' is removed; then the final "drained cleanly" message.
    expect(logs[0]).toMatch(/^draining 2 in-flight session\(s\)/)
    expect(logs.some((l) => l === '1 session(s) still working')).toBe(true)
    expect(logs[logs.length - 1]).toMatch(/^drained cleanly/)
  })
})
