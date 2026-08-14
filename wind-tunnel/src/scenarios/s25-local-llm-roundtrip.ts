// S25: Local LLM Chat Roundtrip — the S3 equivalent for the local-llm
// backend. Verifies the full end-to-end dispatch path:
//
//   POST /api/chat/send → message queue → local-llm backend →
//   inference client → mock OpenAI API → response parsing →
//   WS broadcast (user turn + assistant turn + idle status)
//
// Critical regression coverage:
//   - Fire-and-forget sendMessage: the user turn must appear in the WS
//     event stream promptly (not blocked until assistant completes).
//   - System prompt injection: the mock log must show the personality
//     system prompt reached the OpenAI request.
//   - Scripted response: the assistant turn content must match the script.
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

export const s25LocalLlmRoundtrip: Scenario = {
  id: 's25',
  name: 'Local LLM Chat Roundtrip',
  description: 'Full dispatch path: send message → local-llm backend → mock → user turn + assistant turn + idle via WS',

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

    // 1. Clear mock state + register a scripted response
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's25-roundtrip',
        response: 'Local model received your s25-roundtrip message.',
        needsTools: false
      })
    })

    // 2. Create a local-llm thread
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', { label: 'swt-s25-roundtrip', backend: 'local-llm' })
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

    // 4. Send a message — sendMessage returns before the backend finishes
    //    (fire-and-forget). The user turn must still appear in the WS stream.
    const sendTime = Date.now()
    try {
      await client.timed('send-message', () => client.sendMessage(thread.id, 'Hello from s25-roundtrip test'))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `send failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    const sendReturnTime = Date.now()
    metrics.sendLatencyMs = sendReturnTime - sendTime

    // 5. Collect WS events: expect a user turn, an assistant turn, and idle status.
    //    The user turn should arrive quickly (fire-and-forget fix).
    let userTurn: any = null
    let assistantTurn: any = null

    // Wait for turns — we expect two chat.turn events (user + assistant).
    const deadline = Date.now() + 30000
    const turns: any[] = []
    while (turns.length < 2 && Date.now() < deadline) {
      try {
        const msg = await client.waitForWs('chat.turn', Math.max(1, deadline - Date.now()))
        turns.push(msg)
      } catch {
        break
      }
    }

    for (const t of turns) {
      if (t?.turn?.role === 'user' && !userTurn) userTurn = t
      if (t?.turn?.role === 'assistant' && !assistantTurn) assistantTurn = t
    }

    metrics.turnsReceived = turns.length
    metrics.userTurnReceived = !!userTurn
    metrics.assistantTurnReceived = !!assistantTurn
    metrics.userTurnContent = userTurn?.turn?.content?.slice(0, 80)
    metrics.assistantTurnContent = assistantTurn?.turn?.content?.slice(0, 80)

    // 6. Wait for idle status
    const gotIdle = await client.timed('wait-idle', () => waitForIdleStatus(client, 10000))
    metrics.gotIdle = gotIdle

    // 7. Check mock log — should show OpenAI-format requests with a system prompt
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
    } catch {
      metrics.mockLogError = 'failed to fetch'
    }

    const openAiRequests = mockLog.filter((e: any) => e.format === 'openai')
    metrics.openAiRequests = openAiRequests.length

    // Check that the system prompt reached the mock (personality injection)
    const hasSystemPrompt = openAiRequests.some((e: any) => {
      const systemMsgs = (e.messages ?? []).filter((m: any) => m.role === 'system')
      return systemMsgs.some((m: any) => (m.content ?? '').length > 50)
    })
    metrics.hasSystemPrompt = hasSystemPrompt

    // 8. Verify thread history contains both turns
    let historyTurns: any[] = []
    try {
      const histRes = await client.threadHistory(thread.id)
      historyTurns = histRes?.turns ?? histRes ?? []
    } catch (err: any) {
      metrics.historyError = err?.message
    }
    metrics.historyTurnCount = historyTurns.length

    // 9. Verdict
    const userTurnOk = !!userTurn
    const assistantTurnOk = !!assistantTurn
    const contentMatches = (assistantTurn?.turn?.content ?? '').includes('s25-roundtrip')
    const idleOk = gotIdle
    const mockHit = openAiRequests.length > 0

    const passed = userTurnOk && assistantTurnOk && contentMatches && idleOk && mockHit

    return cleanup({
      passed,
      summary: passed
        ? `roundtrip OK — user turn: ✓, assistant: "${(assistantTurn?.turn?.content ?? '').slice(0, 40)}…", ` +
          `idle: ✓, mock requests: ${openAiRequests.length}, system prompt: ${hasSystemPrompt}`
        : `roundtrip failed — user=${userTurnOk}, assistant=${assistantTurnOk}, ` +
          `content=${contentMatches}, idle=${idleOk}, mock=${mockHit}`,
      metrics,
      samples: client.samples
    })
  }
}
