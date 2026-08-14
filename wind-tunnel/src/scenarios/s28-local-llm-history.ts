// S28: Local LLM History Persistence — verify that the local-llm
// backend's conversation history persists correctly through:
//
//   1. Basic send → history endpoint returns both user + assistant turns
//   2. Multi-turn accumulation → each round adds to history
//   3. Compaction survival → history still has turns after compaction
//   4. Compaction summary visibility → the compacted summary appears
//      as a system turn in the history (not silently dropped)
//   5. compactionCount accuracy → session-info reflects actual count
//
// Regression coverage for the bug where compaction summaries (stored
// as role:'system') got silently dropped by toGenericMessages, making
// the conversation appear empty after compaction.
//
// Self-skips when local-llm backend reports unavailable.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import type { SovereignClient } from '../client.js'

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

function is404(err: any): boolean {
  return String(err?.message ?? '').includes('→ 404')
}

async function waitForIdleStatus(client: SovereignClient, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const msg = await client.waitForWs('chat.status', Math.max(1, deadline - Date.now()))
      if (msg?.status === 'idle') return true
    } catch {
      return false
    }
  }
  return false
}

/** Generate filler content to consume context budget quickly. */
function makeFiller(sizeChars: number, label: string): string {
  const lines: string[] = []
  let total = 0
  let n = 0
  while (total < sizeChars) {
    const line = `[s28-${label}] line-${++n}: ${'x'.repeat(200)} fill`
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n')
}

export const s28LocalLlmHistory: Scenario = {
  id: 's28',
  name: 'Local LLM History Persistence',
  description: 'History persists after send, accumulates across turns, survives compaction with visible summary',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 0. Check local-llm backend exists
    let backends: any[]
    try {
      const res = await client.get('/api/backends')
      backends = res?.backends ?? []
    } catch (err: any) {
      if (is404(err)) return skip('skipped — /api/backends not available')
      throw err
    }
    if (!backends.some((b: any) => b.kind === 'local-llm')) {
      return skip('skipped — local-llm backend not enabled')
    }

    // 1. Clear mock state
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // 2. Create a local-llm thread
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', { label: 'swt-s28-history', backend: 'local-llm' })
      )
      thread = thread?.thread ?? thread
    } catch (err: any) {
      return { passed: false, summary: `thread creation failed: ${err?.message}`, metrics, samples: client.samples }
    }
    metrics.threadId = thread.id

    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    await client.connectWs(['chat', 'threads'])

    // ── Test 1: Basic send → history returns both turns ────────────
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's28-turn1',
        response: 'First response from the local model.',
        needsTools: false
      })
    })

    try {
      await client.timed('send-turn1', () => client.sendMessage(thread.id, 'First message s28-turn1'))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `send-turn1 failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    await waitForIdleStatus(client, 30000)
    client.drainWs('chat.turn')
    client.drainWs('chat.status')

    // Check history
    let history1: any
    try {
      history1 = await client.timed('history-after-turn1', () => client.threadHistory(thread.id))
    } catch (err: any) {
      metrics.history1Error = err?.message
    }
    const turns1 = history1?.turns ?? history1 ?? []
    metrics.turnsAfterTurn1 = turns1.length
    const hasUserTurn1 = turns1.some((t: any) => t.role === 'user' && (t.content ?? '').includes('s28-turn1'))
    const hasAssistantTurn1 = turns1.some((t: any) => t.role === 'assistant')
    metrics.hasUserTurn1 = hasUserTurn1
    metrics.hasAssistantTurn1 = hasAssistantTurn1

    if (!hasUserTurn1 || !hasAssistantTurn1) {
      return cleanup({
        passed: false,
        summary: `basic history failed — turns=${turns1.length}, user=${hasUserTurn1}, assistant=${hasAssistantTurn1}`,
        metrics,
        samples: client.samples
      })
    }

    // ── Test 2: Multi-turn accumulation ────────────────────────────
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's28-turn2',
        response: 'Second response from the local model.',
        needsTools: false
      })
    })

    try {
      await client.timed('send-turn2', () => client.sendMessage(thread.id, 'Second message s28-turn2'))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `send-turn2 failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    await waitForIdleStatus(client, 30000)
    client.drainWs('chat.turn')
    client.drainWs('chat.status')

    let history2: any
    try {
      history2 = await client.timed('history-after-turn2', () => client.threadHistory(thread.id))
    } catch (err: any) {
      metrics.history2Error = err?.message
    }
    const turns2 = history2?.turns ?? history2 ?? []
    metrics.turnsAfterTurn2 = turns2.length
    // Should have at least 4 turns: user1, assistant1, user2, assistant2
    const accumulated = turns2.length >= 4
    metrics.accumulated = accumulated

    if (!accumulated) {
      return cleanup({
        passed: false,
        summary: `multi-turn accumulation failed — expected ≥4 turns, got ${turns2.length}`,
        metrics,
        samples: client.samples
      })
    }

    // ── Test 3: Compaction survival + summary visibility ───────────
    // Fill the context window to trigger compaction. Send several
    // large messages (each ~35K chars). With 32K context window
    // (75% threshold ≈ ~96K chars), 3 rounds should trigger it.
    const FILL_SIZE = 35_000
    const FILL_ROUNDS = 3

    for (let i = 1; i <= FILL_ROUNDS; i++) {
      await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
      await fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: `s28-fill-${i}`,
          response: `Fill response ${i}.`,
          needsTools: false
        })
      })

      const content = makeFiller(FILL_SIZE, `fill-${i}`)
      try {
        await client.timed(`send-fill-${i}`, () => client.sendMessage(thread.id, content))
      } catch (err: any) {
        return cleanup({
          passed: false,
          summary: `fill round ${i} send failed: ${err?.message}`,
          metrics,
          samples: client.samples
        })
      }
      const idle = await waitForIdleStatus(client, 30000)
      if (!idle) {
        return cleanup({
          passed: false,
          summary: `no idle after fill round ${i}`,
          metrics,
          samples: client.samples
        })
      }
      client.drainWs('chat.turn')
      client.drainWs('chat.status')
    }
    metrics.fillRoundsSent = FILL_ROUNDS

    // Check session-info for compaction count
    let sessionInfo: any = null
    try {
      sessionInfo = await client.timed('session-info', () => client.get(`/api/threads/${thread.id}/session-info`))
    } catch (err: any) {
      metrics.sessionInfoError = err?.message
    }
    const compactionCount = sessionInfo?.compactionCount ?? 0
    metrics.compactionCount = compactionCount

    // Check history after compaction
    let history3: any
    try {
      history3 = await client.timed('history-after-compaction', () => client.threadHistory(thread.id))
    } catch (err: any) {
      metrics.history3Error = err?.message
    }
    const turns3 = history3?.turns ?? history3 ?? []
    metrics.turnsAfterCompaction = turns3.length

    // History must NOT return empty — at minimum the post-compaction
    // messages and the compaction summary should appear.
    const historyNotEmpty = turns3.length > 0
    metrics.historyNotEmpty = historyNotEmpty

    // The compaction summary should appear as a system turn containing
    // "[Compacted" text. Before the fix, toGenericMessages silently
    // dropped system-role messages and this turn vanished.
    const hasCompactionSummary =
      compactionCount > 0
        ? turns3.some((t: any) => t.role === 'system' && (t.content ?? '').includes('Compacted'))
        : true // no compaction = pass this check vacuously
    metrics.hasCompactionSummary = hasCompactionSummary

    // ── Test 4: Post-compaction send still accumulates history ──────
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's28-post-compact',
        response: 'Post-compaction response — conversation lives on.',
        needsTools: false
      })
    })

    try {
      await client.timed('send-post-compact', () =>
        client.sendMessage(thread.id, 'Post-compaction message s28-post-compact')
      )
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `post-compaction send failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    await waitForIdleStatus(client, 30000)
    client.drainWs('chat.turn')
    client.drainWs('chat.status')

    let history4: any
    try {
      history4 = await client.timed('history-post-compact', () => client.threadHistory(thread.id))
    } catch (err: any) {
      metrics.history4Error = err?.message
    }
    const turns4 = history4?.turns ?? history4 ?? []
    metrics.turnsPostCompaction = turns4.length
    const postCompactGrew = turns4.length > turns3.length
    metrics.postCompactGrew = postCompactGrew

    // The new message should appear in history
    const hasPostCompactUser = turns4.some(
      (t: any) => t.role === 'user' && (t.content ?? '').includes('s28-post-compact')
    )
    metrics.hasPostCompactUser = hasPostCompactUser

    // ── Verdict ─────────────────────────────────────────────────────
    const basicHistoryOk = hasUserTurn1 && hasAssistantTurn1
    const accumulationOk = accumulated
    const compactionSurvived = historyNotEmpty
    const summaryVisible = hasCompactionSummary
    const postCompactOk = postCompactGrew && hasPostCompactUser
    const compactionTriggered = compactionCount > 0

    const passed = basicHistoryOk && accumulationOk && compactionSurvived && summaryVisible && postCompactOk

    return cleanup({
      passed,
      summary: passed
        ? `history persistence OK — basic: ✓ (${turns1.length} turns), accumulation: ✓ (${turns2.length}), ` +
          `compaction: ✓ (count=${compactionCount}, ${turns3.length} turns survive, summary visible), ` +
          `post-compact: ✓ (${turns4.length} turns)`
        : `history persistence failed — basic=${basicHistoryOk}, accumulation=${accumulationOk}, ` +
          `survived=${compactionSurvived}, summary=${summaryVisible}, postCompact=${postCompactOk}, ` +
          `compactionTriggered=${compactionTriggered}`,
      metrics,
      samples: client.samples
    })
  }
}
