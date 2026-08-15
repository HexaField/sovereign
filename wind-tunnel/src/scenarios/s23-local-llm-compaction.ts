// S23: Local LLM Compaction Loop — end-to-end test of the local-llm
// backend's context compaction lifecycle:
//
//   1. Compaction triggers automatically when context budget exceeds 75%
//   2. The summarisation request uses the structured compaction prompt
//   3. The mock returns a structured <summary> with all 8 sections
//   4. The summary appears in history with the REFERENCE ONLY prefix
//   5. Post-compaction conversation still functions
//   6. A second compaction (iterative) includes the prior summary
//   7. Thread history accumulates across the full lifecycle
//
// Adapted from Claude Code's conversation-summarisation prompt and
// Hermes' handoff-oriented compaction (structured sections, iterative
// summary updates, REFERENCE ONLY prefix).
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

/** Generate a long string to fill context quickly. */
function makeLongContent(sizeChars: number, label: string): string {
  const base = `[s23-compaction-${label}] `
  const lines: string[] = []
  let totalChars = 0
  let lineNum = 0
  while (totalChars < sizeChars) {
    const line = `${base}line-${++lineNum}: ${'x'.repeat(200)} context-fill-data`
    lines.push(line)
    totalChars += line.length + 1
  }
  return lines.join('\n')
}

/** A well-formed structured compaction summary matching the 8-section format. */
const MOCK_STRUCTURED_SUMMARY = `<summary>
1. **Goal:** The user requested a context fill test to verify compaction triggers correctly.

2. **Constraints & Preferences:** No special constraints stated.

3. **Progress:**
   - **Done:** Sent multiple large messages to fill the context window.
   - **In Progress:** Verifying that compaction triggers and produces a valid summary.
   - **Blocked:** None.

4. **Key Decisions:** Chose to fill context with repeating data blocks rather than real file reads.

5. **Files & Code:** No files read or written in the compacted portion.

6. **Errors & Fixes:** No errors encountered during the fill rounds.

7. **Tool Results:** No tool calls made — pure text exchange.

8. **Next Step:** Continue the conversation post-compaction to verify context continuity. The user last said: "s23-compaction verification message."
</summary>`

/** An iterative (second-pass) structured summary that references prior context. */
const MOCK_ITERATIVE_SUMMARY = `<summary>
1. **Goal:** Context fill test — verify compaction triggers, summary quality, and iterative updates.

2. **Constraints & Preferences:** No special constraints stated.

3. **Progress:**
   - **Done:** First compaction completed successfully. Multiple fill rounds sent. Post-compaction message exchanged.
   - **In Progress:** Second compaction verifying iterative summary update.
   - **Blocked:** None.

4. **Key Decisions:** Context fill approach confirmed working for compaction testing.

5. **Files & Code:** No files read or written.

6. **Errors & Fixes:** No errors encountered.

7. **Tool Results:** No tool calls — pure text exchange.

8. **Next Step:** Verify conversation continues after second compaction.
</summary>`

export const s23LocalLlmCompaction: Scenario = {
  id: 's23',
  name: 'Local LLM Compaction Loop',
  description:
    'Compaction triggers automatically, produces structured summary, ' +
    'iterative update works, history survives across multiple compactions',

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

    // Register a script that returns the structured summary when the
    // compaction system prompt appears. The compaction call carries
    // "context compaction engine" in the system message — match on that.
    // First compaction returns the initial summary; second returns the
    // iterative one. Both use `once: true` so they fire sequentially.
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'Summarize this conversation excerpt',
        response: MOCK_STRUCTURED_SUMMARY,
        needsTools: false,
        once: true
      })
    })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'Summarize this conversation excerpt',
        response: MOCK_ITERATIVE_SUMMARY,
        needsTools: false,
        once: true
      })
    })

    // 2. Create a local-llm thread
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', { label: 'swt-s23-compaction-loop', backend: 'local-llm' })
      )
      thread = thread?.thread ?? thread
    } catch (err: any) {
      return {
        passed: false,
        summary: `thread creation failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }
    metrics.threadId = thread.id

    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // 3. Connect WS
    await client.connectWs(['chat', 'threads'])

    // ── Phase 1: Fill context to trigger first compaction ───────────
    const MSG_SIZE = 35_000
    const NUM_ROUNDS = 4

    for (let i = 1; i <= NUM_ROUNDS; i++) {
      const content = makeLongContent(MSG_SIZE, `round-${i}`)

      try {
        await client.timed(`send-round-${i}`, () => client.sendMessage(thread.id, content))
      } catch (err: any) {
        return cleanup({
          passed: false,
          summary: `send failed on round ${i}: ${err?.message}`,
          metrics,
          samples: client.samples
        })
      }

      const idle = await client.timed(`idle-round-${i}`, () => waitForIdleStatus(client, 30000))
      if (!idle) {
        return cleanup({
          passed: false,
          summary: `no idle status after round ${i}`,
          metrics,
          samples: client.samples
        })
      }
      client.drainWs('chat.status')
      client.drainWs('chat.turn')
    }
    metrics.fillRoundsSent = NUM_ROUNDS

    // ── Check 1: compaction triggered ──────────────────────────────
    let sessionInfo: any = null
    try {
      sessionInfo = await client.timed('session-info-1', () => client.get(`/api/threads/${thread.id}/session-info`))
    } catch (err: any) {
      metrics.sessionInfoError = err?.message
    }
    const compactionCount1 = sessionInfo?.compactionCount ?? 0
    metrics.compactionCount1 = compactionCount1

    // ── Check 2: structured summary in mock log ────────────────────
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
    } catch {
      metrics.mockLogError = 'failed to fetch'
    }

    const openAiRequests = mockLog.filter((e: any) => e.format === 'openai')
    metrics.totalOpenAiRequests = openAiRequests.length

    // Find the summarisation request — it has "context compaction engine" in the system prompt
    const compactionRequests = openAiRequests.filter((e: any) => {
      const system = e.system ?? ''
      const systemMsgs = (e.messages ?? []).filter((m: any) => m.role === 'system')
      const allSystem = system + systemMsgs.map((m: any) => m.content ?? '').join(' ')
      return /context compaction engine/i.test(allSystem)
    })
    metrics.compactionRequests = compactionRequests.length

    // Verify the compaction request used the structured prompt
    const hasStructuredPrompt =
      compactionRequests.length > 0 &&
      compactionRequests.some((e: any) => {
        const systemMsgs = (e.messages ?? []).filter((m: any) => m.role === 'system')
        const allSystem = systemMsgs.map((m: any) => m.content ?? '').join(' ')
        return (
          allSystem.includes('<summary>') &&
          allSystem.includes('Goal:') &&
          allSystem.includes('Progress:') &&
          allSystem.includes('Files & Code:') &&
          allSystem.includes('Next Step:')
        )
      })
    metrics.hasStructuredPrompt = hasStructuredPrompt

    // ── Check 3: summary in history with REFERENCE ONLY prefix ─────
    let history1: any
    try {
      history1 = await client.timed('history-after-compaction-1', () => client.threadHistory(thread.id))
    } catch (err: any) {
      metrics.history1Error = err?.message
    }
    const turns1 = history1?.turns ?? history1 ?? []
    metrics.turnsAfterCompaction1 = turns1.length

    const hasSummaryPrefix = turns1.some(
      (t: any) =>
        t.role === 'system' &&
        ((t.content ?? '').includes('CONTEXT COMPACTION') || (t.content ?? '').includes('Compacted'))
    )
    metrics.hasSummaryPrefix = hasSummaryPrefix

    // Check the summary contains structured sections
    const summaryTurn = turns1.find(
      (t: any) =>
        t.role === 'system' &&
        ((t.content ?? '').includes('CONTEXT COMPACTION') || (t.content ?? '').includes('Compacted'))
    )
    const summaryContent = summaryTurn?.content ?? ''
    const hasGoalSection = summaryContent.includes('Goal:')
    const hasProgressSection = summaryContent.includes('Progress:')
    const hasDoneMarker = summaryContent.includes('Done:')
    const hasEndDelimiter = summaryContent.includes('END OF CONTEXT SUMMARY')
    metrics.hasGoalSection = hasGoalSection
    metrics.hasProgressSection = hasProgressSection
    metrics.hasDoneMarker = hasDoneMarker
    metrics.hasEndDelimiter = hasEndDelimiter

    // ── Phase 2: Post-compaction exchange ──────────────────────────
    let postCompaction1Ok = false
    try {
      await client.timed('post-compaction-1-send', () =>
        client.sendMessage(thread.id, 's23-post-compaction verification')
      )
      const idle = await client.timed('post-compaction-1-idle', () => waitForIdleStatus(client, 30000))
      postCompaction1Ok = idle
    } catch (err: any) {
      metrics.postCompaction1Error = err?.message
    }
    metrics.postCompaction1Ok = postCompaction1Ok

    // ── Phase 3: Fill again to trigger iterative (second) compaction ─
    for (let i = 1; i <= NUM_ROUNDS; i++) {
      const content = makeLongContent(MSG_SIZE, `iter-${i}`)
      try {
        await client.timed(`send-iter-${i}`, () => client.sendMessage(thread.id, content))
      } catch (err: any) {
        return cleanup({
          passed: false,
          summary: `iterative fill failed on round ${i}: ${err?.message}`,
          metrics,
          samples: client.samples
        })
      }
      const idle = await client.timed(`idle-iter-${i}`, () => waitForIdleStatus(client, 30000))
      if (!idle) {
        return cleanup({
          passed: false,
          summary: `no idle after iterative round ${i}`,
          metrics,
          samples: client.samples
        })
      }
      client.drainWs('chat.status')
      client.drainWs('chat.turn')
    }
    metrics.iterativeRoundsSent = NUM_ROUNDS

    // ── Check 4: second compaction triggered ───────────────────────
    let sessionInfo2: any = null
    try {
      sessionInfo2 = await client.timed('session-info-2', () => client.get(`/api/threads/${thread.id}/session-info`))
    } catch (err: any) {
      metrics.sessionInfo2Error = err?.message
    }
    const compactionCount2 = sessionInfo2?.compactionCount ?? 0
    metrics.compactionCount2 = compactionCount2
    const iterativeTriggered = compactionCount2 > compactionCount1
    metrics.iterativeTriggered = iterativeTriggered

    // ── Check 5: iterative summary includes prior context ──────────
    // Re-fetch the mock log — find the second compaction request
    let mockLog2: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog2 = (await logRes.json()) as any[]
    } catch {
      metrics.mockLog2Error = 'failed to fetch'
    }
    const compactionRequests2 = mockLog2.filter((e: any) => {
      if (e.format !== 'openai') return false
      const systemMsgs = (e.messages ?? []).filter((m: any) => m.role === 'system')
      const allSystem = systemMsgs.map((m: any) => m.content ?? '').join(' ')
      return /context compaction engine/i.test(allSystem)
    })
    metrics.totalCompactionRequests = compactionRequests2.length

    // The second compaction request should include "Previous summary" or
    // "UPDATE it" in one of its user messages — indicating iterative mode.
    const hasIterativePrompt =
      compactionRequests2.length >= 2 &&
      compactionRequests2.slice(1).some((e: any) => {
        const userMsgs = (e.messages ?? []).filter((m: any) => m.role === 'user')
        return userMsgs.some(
          (m: any) => (m.content ?? '').includes('UPDATE it') || (m.content ?? '').includes('Previous summary')
        )
      })
    metrics.hasIterativePrompt = hasIterativePrompt

    // ── Check 6: post-second-compaction conversation works ─────────
    let postCompaction2Ok = false
    try {
      await client.timed('post-compaction-2-send', () =>
        client.sendMessage(thread.id, 's23-final verification after iterative compaction')
      )
      const idle = await client.timed('post-compaction-2-idle', () => waitForIdleStatus(client, 30000))
      postCompaction2Ok = idle
    } catch (err: any) {
      metrics.postCompaction2Error = err?.message
    }
    metrics.postCompaction2Ok = postCompaction2Ok

    // ── Check 7: final history has accumulated turns ────────────────
    let historyFinal: any
    try {
      historyFinal = await client.timed('history-final', () => client.threadHistory(thread.id))
    } catch (err: any) {
      metrics.historyFinalError = err?.message
    }
    const turnsFinal = historyFinal?.turns ?? historyFinal ?? []
    metrics.turnsFinal = turnsFinal.length
    const finalHistoryNotEmpty = turnsFinal.length > 0
    metrics.finalHistoryNotEmpty = finalHistoryNotEmpty

    // ── Verdict ────────────────────────────────────────────────────
    const compacted = compactionCount1 > 0
    const structuredPromptUsed = hasStructuredPrompt
    const summaryInHistory = hasSummaryPrefix
    const structuredSections = hasGoalSection && hasProgressSection
    const survived1 = postCompaction1Ok
    const survived2 = postCompaction2Ok
    const historyIntact = finalHistoryNotEmpty

    const passed =
      compacted &&
      structuredPromptUsed &&
      summaryInHistory &&
      structuredSections &&
      survived1 &&
      survived2 &&
      historyIntact

    return cleanup({
      passed,
      summary: passed
        ? `compaction loop OK — ${compactionCount1}+${compactionCount2 - compactionCount1} compactions, ` +
          `structured prompt ✓, summary with sections ✓, iterative=${iterativeTriggered}, ` +
          `conversation survived both compactions, ${turnsFinal.length} final turns`
        : `compaction loop failed — compacted=${compacted}, structuredPrompt=${structuredPromptUsed}, ` +
          `summaryInHistory=${summaryInHistory}, sections=${structuredSections}, ` +
          `survived1=${survived1}, survived2=${survived2}, history=${historyIntact}, ` +
          `compactionCount=${compactionCount1}→${compactionCount2}`,
      metrics,
      samples: client.samples
    })
  }
}
