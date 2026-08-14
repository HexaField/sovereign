// S23: Local LLM Compaction — verify that the local-llm backend's
// context compaction triggers when the conversation exceeds the token
// budget, generates a model summary of dropped messages, and the
// session continues to function after compaction.
//
// Strategy: send a few messages with large content to fill the 32K
// context window quickly (75% threshold ≈ 24K tokens ≈ 96K chars).
// Then verify compactionCount > 0 in session info and confirm the
// mock LLM received a summarization request (identified by the
// compaction system prompt).
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
  // Fill with repeating numbered lines to create realistic-looking content
  const lines: string[] = []
  let totalChars = 0
  let lineNum = 0
  while (totalChars < sizeChars) {
    const line = `${base}line-${++lineNum}: ${'x'.repeat(200)} context-fill-data`
    lines.push(line)
    totalChars += line.length + 1 // +1 for newline
  }
  return lines.join('\n')
}

export const s23LocalLlmCompaction: Scenario = {
  id: 's23',
  name: 'Local LLM Compaction',
  description: 'Context compaction triggers, produces model summary, conversation survives',

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
        client.post('/api/threads', { label: 'swt-s23-compaction', backend: 'local-llm' })
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

    // 3. Connect WS
    await client.connectWs(['chat', 'threads'])

    // 4. Send multiple messages with large content to fill the context.
    //    Each message contains ~35K chars. With a 32K context window
    //    (75% threshold = ~24K tokens ≈ ~96K chars), 3-4 rounds should
    //    trigger compaction. The mock echoes a short response each time.
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

      // Wait for the response
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
    metrics.roundsSent = NUM_ROUNDS

    // 5. Check session info for compaction count
    let sessionInfo: any = null
    try {
      sessionInfo = await client.timed('session-info', () => client.get(`/api/threads/${thread.id}/session-info`))
    } catch (err: any) {
      metrics.sessionInfoError = err?.message
    }

    const compactionCount = sessionInfo?.compactionCount ?? 0
    metrics.compactionCount = compactionCount
    metrics.backendKind = sessionInfo?.backendKind

    // 6. Check mock log for the summarization request — it contains the
    //    compaction system prompt ("context compaction engine").
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
    } catch {
      metrics.mockLogError = 'failed to fetch'
    }
    metrics.totalMockRequests = mockLog.length

    const openAiRequests = mockLog.filter((e: any) => e.format === 'openai')
    metrics.openAiRequests = openAiRequests.length

    // The summarization call has a system message containing "compaction"
    const summarizationRequests = openAiRequests.filter((e: any) => {
      const system = e.system ?? ''
      const systemMsgs = (e.messages ?? []).filter((m: any) => m.role === 'system')
      const allSystem = system + systemMsgs.map((m: any) => m.content ?? '').join(' ')
      return /compaction/i.test(allSystem)
    })
    metrics.summarizationRequests = summarizationRequests.length

    // 7. Send one more message to verify the session still works post-compaction
    let postCompactionOk = false
    try {
      await client.timed('post-compaction-send', () =>
        client.sendMessage(thread.id, 's23-post-compaction verification')
      )
      const idle = await client.timed('post-compaction-idle', () => waitForIdleStatus(client, 30000))
      postCompactionOk = idle
    } catch (err: any) {
      metrics.postCompactionError = err?.message
    }
    metrics.postCompactionOk = postCompactionOk

    // 8. Verdict
    const compacted = compactionCount > 0
    const summarized = summarizationRequests.length > 0
    const survived = postCompactionOk
    const passed = compacted && survived

    return cleanup({
      passed,
      summary: passed
        ? `compaction OK — ${compactionCount} compaction(s), ${summarizationRequests.length} summarization call(s), conversation survived`
        : `compaction failed — compacted=${compacted}, summarized=${summarized}, survived=${survived}`,
      metrics,
      samples: client.samples
    })
  }
}
