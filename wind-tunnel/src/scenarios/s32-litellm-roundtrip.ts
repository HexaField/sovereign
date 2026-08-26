// S32: LiteLLM Chat Roundtrip — verifies that when `SOVEREIGN_LITELLM_URL`
// is configured, Sovereign correctly injects `ANTHROPIC_BASE_URL` into the
// Claude Code SDK subprocess and routes requests through the proxy.
//
// Test chain:
//   POST /api/chat/send → message queue → claude-code backend (env injection)
//     → SDK subprocess (ANTHROPIC_BASE_URL=litellm) → litellm proxy
//     → mock-llm (Anthropic-format endpoint) → response back
//     → WS broadcast (user turn + assistant turn + idle)
//
// In the standard wind tunnel (no --litellm flag), Sovereign's SOVEREIGN_LITELLM_URL
// is unset and this scenario self-skips. Run with --litellm to enable:
//   ./run.sh --litellm --scenario s32
//
// In the litellm-overlay run, SOVEREIGN_LITELLM_URL points to the mock-llm
// (which handles Anthropic format directly) acting as a lightweight proxy
// stand-in. In production, LiteLLM receives Anthropic Messages API requests
// and translates them to OpenAI format for the local llama-server.
//
// Self-skips when:
//   - SWT_LITELLM_URL env var is not set (standard wind tunnel run)
//   - Sovereign's claude-code backend reports litellm unconfigured
//   - /api/backends returns 404

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

export const s32LiteLlmRoundtrip: Scenario = {
  id: 's32',
  name: 'LiteLLM Chat Roundtrip',
  description:
    'Env injection: SOVEREIGN_LITELLM_URL → sdkOptions.env → SDK routes via proxy → non-Claude model roundtrip',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 0. Self-skip unless the litellm lane is active
    const litellmUrl = process.env.SWT_LITELLM_URL?.trim()
    if (!litellmUrl) {
      return skip('skipped — SWT_LITELLM_URL not set (run with --litellm to enable)')
    }
    metrics.litellmUrl = litellmUrl

    // 1. Check the claude-code backend is available
    let backends: any[]
    try {
      const res = await client.get('/api/backends')
      backends = res?.backends ?? []
    } catch (err: any) {
      if (is404(err)) return skip('skipped — /api/backends not available')
      throw err
    }
    if (!backends.some((b: any) => b.kind === 'claude-code')) {
      return skip('skipped — claude-code backend not enabled')
    }

    // 2. Verify the model catalog includes proxy models (dynamic catalog feature)
    let catalogOk = false
    try {
      const models = await client.get('/api/models?backend=claude-code')
      const catalog = models?.catalog ?? []
      // Catalog should include at least one entry (static Claude models always present)
      catalogOk = catalog.length > 0
      metrics.catalogLength = catalog.length
      // Report whether any non-Claude entries appeared (litellm dynamic models)
      const externalModels = catalog.filter((m: any) => !String(m?.id ?? '').includes('claude-'))
      metrics.externalModelCount = externalModels.length
      metrics.externalModels = externalModels.map((m: any) => m?.id).slice(0, 5)
    } catch (err: any) {
      metrics.catalogError = err?.message ?? 'unknown'
    }
    metrics.catalogOk = catalogOk

    // 3. Clear mock state + register a scripted response keyed to this scenario
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's32-litellm',
        response: 'LiteLLM proxy received your s32-litellm message.',
        needsTools: false
      })
    })

    // 4. Create a claude-code thread with a non-Claude model name to exercise
    //    the litellm routing path. The env injection fires only for non-Claude
    //    models (familyForModel returns null → inject ANTHROPIC_BASE_URL).
    //    Claude models retain normal OAuth auth and are not affected.
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', {
          label: 'swt-s32-litellm',
          backend: 'claude-code',
          model: 'anthropic/qwen3.6-35b'
        })
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
    metrics.threadModel = thread.model

    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // 5. Connect WS
    await client.connectWs(['chat', 'threads'])

    // 6. Send a message — fire-and-forget (user turn must appear promptly)
    const sendTime = Date.now()
    try {
      await client.timed('send-message', () => client.sendMessage(thread.id, 'Hello from s32-litellm test'))
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

    // 7. Collect WS events: user turn + assistant turn
    let userTurn: any = null
    let assistantTurn: any = null
    const deadline = Date.now() + 60000
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
    metrics.assistantTurnContent = assistantTurn?.turn?.content?.slice(0, 80)

    // 8. Wait for idle
    const gotIdle = await client.timed('wait-idle', () => waitForIdleStatus(client, 15000))
    metrics.gotIdle = gotIdle

    // 9. Check mock log — must contain Anthropic-format requests. This is the
    //    key assertion: it proves ANTHROPIC_BASE_URL was injected and the SDK
    //    routed to the proxy in Anthropic message format (not OpenAI format).
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
    } catch {
      metrics.mockLogError = 'failed to fetch'
    }
    const anthropicRequests = mockLog.filter((e: any) => e.format === 'anthropic')
    metrics.anthropicRequests = anthropicRequests.length
    metrics.mockTotalRequests = mockLog.length

    // Verify the request carried a system prompt (personality injection)
    const hasSystemPrompt = anthropicRequests.some((e: any) => typeof e.system === 'string' && e.system.length > 20)
    metrics.hasSystemPrompt = hasSystemPrompt

    // 10. Verdict
    const userTurnOk = !!userTurn
    const assistantTurnOk = !!assistantTurn
    const contentMatches = (assistantTurn?.turn?.content ?? '').includes('s32-litellm')
    const idleOk = gotIdle
    const proxyHit = anthropicRequests.length > 0

    const passed = userTurnOk && assistantTurnOk && contentMatches && idleOk && proxyHit

    return cleanup({
      passed,
      summary: passed
        ? `LiteLLM roundtrip OK — user: ✓, assistant: "${(assistantTurn?.turn?.content ?? '').slice(0, 40)}…", ` +
          `idle: ✓, proxy hits (Anthropic-format): ${anthropicRequests.length}, system prompt: ${hasSystemPrompt}`
        : `LiteLLM roundtrip failed — user=${userTurnOk}, assistant=${assistantTurnOk}, ` +
          `content=${contentMatches}, idle=${idleOk}, proxy=${proxyHit}`,
      metrics,
      samples: client.samples
    })
  }
}
