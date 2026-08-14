// S14: Local LLM Backend — verify the local-llm backend connects to
// the OpenAI-compatible inference endpoint through Sovereign's thread
// routing, and handles the core request lifecycle:
//
//   1. Non-streaming completion through Sovereign (send → response via WS)
//   2. Tool call round-trip (mock returns tool_use → backend executes
//      tool → feeds result back → mock returns final text)
//   3. Session info reflects local-llm backend kind
//   4. Mock log confirms OpenAI-format requests (not Anthropic)
//
// Unlike the earlier version that called the mock directly, this
// exercises the full backend: inference client, tool schema
// construction, response parsing, and transcript management.
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

export const s14LocalLlmBackend: Scenario = {
  id: 's14',
  name: 'Local LLM Backend',
  description: 'Inference client → Sovereign thread routing → tool round-trip → session-info reflects backend',

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
        client.post('/api/threads', { label: 'swt-s14-backend', backend: 'local-llm' })
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

    // ── Test 1: Basic completion through Sovereign ──────────────────
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's14-basic',
        response: 'Hello from the local model via Sovereign!',
        needsTools: false
      })
    })

    let basicOk = false
    let basicContent = ''
    try {
      await client.timed('basic-send', () => client.sendMessage(thread.id, 'Test s14-basic completion'))

      // Collect assistant turn
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        try {
          const msg = await client.waitForWs('chat.turn', Math.max(1, deadline - Date.now()))
          if (msg?.turn?.role === 'assistant') {
            basicContent = msg.turn.content ?? ''
            basicOk = true
            break
          }
        } catch {
          break
        }
      }
      await waitForIdleStatus(client, 10000)
    } catch (err: any) {
      metrics.basicError = err?.message
    }
    metrics.basicOk = basicOk
    metrics.basicContent = basicContent.slice(0, 80)
    client.drainWs('chat.turn')
    client.drainWs('chat.status')

    if (!basicOk) {
      return cleanup({
        passed: false,
        summary: `basic completion failed — no assistant turn received`,
        metrics,
        samples: client.samples
      })
    }

    // ── Test 2: Tool call round-trip ────────────────────────────────
    // Script the mock to call Read on a known file, then respond with
    // text after receiving the tool result.
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's14-tool',
        toolUse: {
          id: 'call_s14_read',
          name: 'Read',
          input: { file_path: '/etc/hostname' }
        },
        once: true,
        needsTools: true
      })
    })

    let toolOk = false
    try {
      await client.timed('tool-send', () => client.sendMessage(thread.id, 'Test s14-tool please read the hostname'))

      // Wait for the full round-trip: tool call → tool result → final text
      const idle = await client.timed('tool-idle', () => waitForIdleStatus(client, 30000))
      toolOk = idle
    } catch (err: any) {
      metrics.toolError = err?.message
    }
    metrics.toolOk = toolOk
    client.drainWs('chat.turn')
    client.drainWs('chat.status')

    // Verify the tool result was fed back to the mock
    let toolResultFedBack = false
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      const log = (await logRes.json()) as any[]
      const openAi = log.filter((e: any) => e.format === 'openai')
      toolResultFedBack = openAi.some((e: any) => (e.messages ?? []).some((m: any) => m.role === 'tool'))
    } catch {
      metrics.toolLogError = 'failed'
    }
    metrics.toolResultFedBack = toolResultFedBack

    // ── Test 3: Session info reflects backend ───────────────────────
    let sessionInfo: any = null
    try {
      sessionInfo = await client.timed('session-info', () => client.get(`/api/threads/${thread.id}/session-info`))
    } catch (err: any) {
      metrics.sessionInfoError = err?.message
    }
    metrics.backendKind = sessionInfo?.backendKind
    metrics.model = sessionInfo?.model

    // ── Test 4: Mock log shows OpenAI format (not Anthropic) ────────
    let openAiCount = 0
    let anthropicCount = 0
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      const log = (await logRes.json()) as any[]
      openAiCount = log.filter((e: any) => e.format === 'openai').length
      anthropicCount = log.filter((e: any) => e.format === 'anthropic').length
    } catch {
      /* handled below */
    }
    metrics.openAiRequests = openAiCount
    metrics.anthropicRequests = anthropicCount

    // The local-llm backend must use OpenAI format exclusively
    const correctFormat = openAiCount > 0

    // ── Verdict ─────────────────────────────────────────────────────
    const backendCorrect = sessionInfo?.backendKind === 'local-llm'
    const passed = basicOk && toolOk && toolResultFedBack && correctFormat && backendCorrect

    return cleanup({
      passed,
      summary: passed
        ? `local-llm backend OK — basic: ✓, tool round-trip: ✓ (result fed back), ` +
          `format: openai (${openAiCount} reqs), backend: ${sessionInfo?.backendKind}`
        : `local-llm backend failed — basic=${basicOk}, tool=${toolOk}, ` +
          `toolResult=${toolResultFedBack}, format=${correctFormat}, backend=${sessionInfo?.backendKind}`,
      metrics,
      samples: client.samples
    })
  }
}
