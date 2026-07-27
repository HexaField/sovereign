import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createActiveSessions } from './active-sessions.js'
import { resumeActiveSessions, buildContinuationMarker, type ResumeOrchestratorOptions } from './resume.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function makeBus() {
  const emitted: Array<{ type: string; payload: unknown }> = []
  return {
    emitted,
    bus: {
      emit(event: { type: string; payload: unknown }) {
        emitted.push({ type: event.type, payload: event.payload })
      },
      on() {},
      off() {}
    } as any
  }
}

function makeOrchestratorDeps(over: Partial<ResumeOrchestratorOptions>) {
  const { bus, emitted } = makeBus()
  const replayQueueHead = vi.fn(() => true)
  const dropQueueHead = vi.fn()
  // Typed args so tests can assert on `.mock.calls[n][1]` (the marker text).
  const sendContinuation = vi.fn((_threadKey: string, _text: string) => Promise.resolve())
  const getAllQueues = vi.fn(() => new Map<string, Array<{ id: string; status: string; text: string }>>())
  return {
    deps: {
      bus,
      replayQueueHead,
      dropQueueHead,
      sendContinuation,
      getAllQueues,
      activeSessions: undefined as any,
      routingBackend: {} as any,
      ...over
    } satisfies ResumeOrchestratorOptions,
    emitted,
    replayQueueHead,
    dropQueueHead,
    sendContinuation,
    getAllQueues
  }
}

describe('buildContinuationMarker', () => {
  const BASE = '[Resumed after server restart. Continue from where you left off.]'

  it('returns the bare marker when no in-flight prompt was recorded', () => {
    expect(buildContinuationMarker(BASE)).toBe(BASE)
    expect(buildContinuationMarker(BASE, '   ')).toBe(BASE)
  })

  it('quotes the in-flight prompt so the model recovers the task', () => {
    const out = buildContinuationMarker(BASE, 'refactor the parser')
    expect(out).toContain('You were working on: "refactor the parser"')
    // Prefix must survive — it is what the UI folds on.
    expect(out.startsWith('[Resumed after server restart')).toBe(true)
  })

  it('collapses whitespace and truncates long prompts', () => {
    const long = 'x'.repeat(400)
    const out = buildContinuationMarker(BASE, `multi\n  line\tprompt ${long}`)
    expect(out).toContain('multi line prompt')
    expect(out).toContain('…')
    expect(out.length).toBeLessThan(320)
  })
})

describe('resumeActiveSessions', () => {
  it('is a no-op when no active sessions exist', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    const { deps, replayQueueHead, sendContinuation } = makeOrchestratorDeps({ activeSessions: active })
    const report = await resumeActiveSessions(deps)
    expect(report.outcomes).toHaveLength(0)
    expect(replayQueueHead).not.toHaveBeenCalled()
    expect(sendContinuation).not.toHaveBeenCalled()
  })

  it('Tier 1: replays the queue head when inFlightQueueId matches', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      agentStatus: 'working',
      lastTransitionAt: Date.now(),
      inFlightQueueId: 'q-1',
      inFlightPromptText: 'hello'
    })
    const { deps, replayQueueHead, sendContinuation } = makeOrchestratorDeps({
      activeSessions: active,
      getAllQueues: () => new Map([['foo', [{ id: 'q-1', status: 'sending', text: 'hello' }]]])
    })
    const report = await resumeActiveSessions(deps)
    expect(replayQueueHead).toHaveBeenCalledWith('q-1')
    expect(sendContinuation).not.toHaveBeenCalled()
    expect(report.counts.tier1).toBe(1)
  })

  it('Tier 2: drops the entry when JSONL shows the assistant turn finished', async () => {
    const sessionFile = path.join(tmpDir, 'session.jsonl')
    // The prompt is included so the coherence detector can find it; the
    // assistant turn must carry a `stop_reason` to count as "complete".
    fs.writeFileSync(sessionFile, '')
    const startSize = 0
    const trailingTurn =
      JSON.stringify({ type: 'user', message: { content: 'hello' } }) +
      '\n' +
      JSON.stringify({ type: 'assistant', message: { content: 'hi', stop_reason: 'end_turn' } }) +
      '\n'
    fs.writeFileSync(sessionFile, trailingTurn)

    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      backendSessionFile: sessionFile,
      agentStatus: 'working',
      lastTransitionAt: Date.now(),
      inFlightQueueId: 'q-2',
      inFlightPromptText: 'hello',
      lastJsonlSize: startSize
    })
    const { deps, replayQueueHead, sendContinuation, dropQueueHead } = makeOrchestratorDeps({
      activeSessions: active
    })
    const report = await resumeActiveSessions(deps)
    expect(report.counts.tier2).toBe(1)
    expect(dropQueueHead).toHaveBeenCalledWith('q-2')
    expect(replayQueueHead).not.toHaveBeenCalled()
    expect(sendContinuation).not.toHaveBeenCalled()
    expect(active.list()).toHaveLength(0)
  })

  it('Tier 3: auto-continues a session with no in-flight queue head', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      agentStatus: 'working',
      lastTransitionAt: Date.now()
    })
    const { deps, sendContinuation, replayQueueHead } = makeOrchestratorDeps({ activeSessions: active })
    const report = await resumeActiveSessions(deps)
    expect(report.counts.tier3).toBe(1)
    expect(sendContinuation).toHaveBeenCalledWith(
      'foo',
      '[Resumed after server restart. Continue from where you left off.]'
    )
    expect(replayQueueHead).not.toHaveBeenCalled()
  })

  it('Tier 3 continuation carries the in-flight prompt as context', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      agentStatus: 'working',
      lastTransitionAt: Date.now(),
      inFlightPromptText: 'summarise the AD4M spec'
    })
    const { deps, sendContinuation } = makeOrchestratorDeps({ activeSessions: active })
    await resumeActiveSessions(deps)
    const [, text] = sendContinuation.mock.calls[0]
    expect(text).toContain('summarise the AD4M spec')
    expect(text.startsWith('[Resumed after server restart')).toBe(true)
  })

  it('tool-await: skips continuation for a session the PreToolUse hook was holding open', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      agentStatus: 'working',
      lastTransitionAt: Date.now(),
      pendingToolAwait: {
        toolName: 'AskUserQuestion',
        toolCallId: 'tool-abc',
        startedAt: Date.now()
      }
    })
    const { deps, sendContinuation, replayQueueHead } = makeOrchestratorDeps({ activeSessions: active })
    const report = await resumeActiveSessions(deps)
    expect(report.counts.toolAwait).toBe(1)
    expect(report.counts.tier3).toBe(0)
    expect(sendContinuation).not.toHaveBeenCalled()
    expect(replayQueueHead).not.toHaveBeenCalled()
    // The entry stays so the hook re-fire on session resume can refresh it.
    expect(active.list()).toHaveLength(1)
    // Reason includes the tool name so operators can grep the resume log.
    expect(report.outcomes[0].reason).toContain('AskUserQuestion')
  })

  it('invalidates entries whose backend session file is gone, with subagent fan-out', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      backendSessionFile: '/does/not/exist.jsonl',
      agentStatus: 'working',
      lastTransitionAt: Date.now(),
      subagents: [
        { agentId: 'sub-1', startedAt: 0 },
        { agentId: 'sub-2', startedAt: 0 }
      ]
    })
    const { deps, emitted, sendContinuation } = makeOrchestratorDeps({ activeSessions: active })
    const report = await resumeActiveSessions(deps)
    expect(report.counts.invalidated).toBe(1)
    expect(sendContinuation).not.toHaveBeenCalled()
    expect(active.list()).toHaveLength(0)
    const subagentCompletions = emitted.filter((e) => e.type === 'subagent.completed')
    expect(subagentCompletions).toHaveLength(2)
  })

  it('emits a system.resume bus event with counts', async () => {
    const active = createActiveSessions({ dataDir: tmpDir })
    active.upsert({
      sessionKey: 'agent:main:thread:foo',
      threadKey: 'foo',
      backendKind: 'claude-code',
      backendSessionId: 'uuid',
      agentStatus: 'working',
      lastTransitionAt: Date.now()
    })
    const { deps, emitted } = makeOrchestratorDeps({ activeSessions: active })
    await resumeActiveSessions(deps)
    const event = emitted.find((e) => e.type === 'system.resume')
    expect(event).toBeDefined()
    const payload = event!.payload as any
    expect(payload.counts.tier3).toBe(1)
  })
})
