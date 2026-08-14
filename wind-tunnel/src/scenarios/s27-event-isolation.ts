// S27: Event Isolation — verify that events from a local-llm thread
// do NOT leak into a claude-code thread's SSE/WS stream, and vice versa.
//
// Proves the fix for the cross-thread message routing bug where content
// from one thread appeared in another thread's conversation.
//
// Strategy:
//   1. Create two threads: one local-llm, one claude-code (default).
//   2. Connect SSE to each thread (via /api/threads/:key/events).
//   3. Send a message to the local-llm thread with a unique marker.
//   4. Send a message to the claude-code thread with a different marker.
//   5. Verify each thread's SSE stream contains ONLY its own marker.
//   6. Verify WS broadcasts carry the correct threadId on every event.
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

/** Collect SSE events from a thread until idle or timeout. */
async function collectSSE(
  baseUrl: string,
  threadId: string,
  timeoutMs: number
): Promise<{ turns: any[]; statuses: any[]; errors: any[] }> {
  const turns: any[] = []
  const statuses: any[] = []
  const errors: any[] = []

  const url = `${baseUrl}/api/threads/${encodeURIComponent(threadId)}/events`

  // Use a simple fetch + ReadableStream to consume SSE (Node 18+)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      clearTimeout(timer)
      return { turns, statuses, errors }
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let gotIdle = false

    while (!gotIdle) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          // Next data line carries the payload
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6))
            if (data.turn) turns.push(data)
            if (data.status) {
              statuses.push(data)
              if (data.status === 'idle') gotIdle = true
            }
            if (data.error) errors.push(data)
          } catch {
            /* parse error — skip */
          }
        }
      }
    }

    reader.cancel().catch(() => {})
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      errors.push({ error: err?.message })
    }
  }

  clearTimeout(timer)
  return { turns, statuses, errors }
}

export const s27EventIsolation: Scenario = {
  id: 's27',
  name: 'Event Isolation',
  description: 'Local-llm and claude-code thread events stay isolated — no cross-thread leakage',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 0. Check both backends exist
    let backends: any[]
    try {
      const res = await client.get('/api/backends')
      backends = res?.backends ?? []
    } catch (err: any) {
      if (is404(err)) return skip('skipped — /api/backends not available')
      throw err
    }
    const hasLocalLlm = backends.some((b: any) => b.kind === 'local-llm')
    const hasClaudeCode = backends.some((b: any) => b.kind === 'claude-code')
    if (!hasLocalLlm || !hasClaudeCode) {
      return skip(`skipped — need both backends (local-llm=${hasLocalLlm}, claude-code=${hasClaudeCode})`)
    }

    // 1. Clear mock state + register distinct scripted responses
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    const MARKER_LOCAL = 'MARKER-S27-LOCAL-' + Date.now()
    const MARKER_CLAUDE = 'MARKER-S27-CLAUDE-' + Date.now()

    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's27-local-thread',
        response: `Response from local thread: ${MARKER_LOCAL}`,
        needsTools: false
      })
    })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's27-claude-thread',
        response: `Response from claude thread: ${MARKER_CLAUDE}`,
        needsTools: false
      })
    })

    // 2. Create two threads
    let threadLocal: any
    let threadClaude: any
    try {
      threadLocal = await client.timed('create-local-thread', () =>
        client.post('/api/threads', { label: 'swt-s27-local', backend: 'local-llm' })
      )
      threadLocal = threadLocal?.thread ?? threadLocal
    } catch (err: any) {
      return {
        passed: false,
        summary: `local thread creation failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }
    try {
      threadClaude = await client.timed('create-claude-thread', () =>
        client.post('/api/threads', { label: 'swt-s27-claude', backend: 'claude-code' })
      )
      threadClaude = threadClaude?.thread ?? threadClaude
    } catch (err: any) {
      await client.deleteThread(threadLocal.id).catch(() => {})
      return {
        passed: false,
        summary: `claude thread creation failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }
    metrics.localThreadId = threadLocal.id
    metrics.claudeThreadId = threadClaude.id

    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(threadLocal.id).catch(() => {})
      await client.deleteThread(threadClaude.id).catch(() => {})
      return result
    }

    // 3. Connect WS to capture broadcast events
    await client.connectWs(['chat', 'threads'])

    // 4. Send messages to both threads. Start SSE collection in parallel.
    const sseLocalPromise = collectSSE(client.baseUrl, threadLocal.id, 30000)
    const sseClaudePromise = collectSSE(client.baseUrl, threadClaude.id, 30000)

    // Small delay to let SSE connections establish
    await new Promise((r) => setTimeout(r, 200))

    try {
      await client.timed('send-local', () => client.sendMessage(threadLocal.id, 'Hello from s27-local-thread test'))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `send to local thread failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }

    try {
      await client.timed('send-claude', () => client.sendMessage(threadClaude.id, 'Hello from s27-claude-thread test'))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `send to claude thread failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }

    // 5. Wait for both SSE streams to settle
    const [sseLocal, sseClaude] = await Promise.all([sseLocalPromise, sseClaudePromise])

    metrics.localSSETurns = sseLocal.turns.length
    metrics.claudeSSETurns = sseClaude.turns.length

    // 6. Verify isolation: each SSE stream must contain ONLY its own content

    // Local thread's SSE must NOT contain the claude marker
    const localTurnTexts = sseLocal.turns.map((t: any) => t.turn?.content ?? '').join(' ')
    const localContainsClaude = localTurnTexts.includes(MARKER_CLAUDE)
    metrics.localContainsClaudeMarker = localContainsClaude

    // Claude thread's SSE must NOT contain the local marker
    const claudeTurnTexts = sseClaude.turns.map((t: any) => t.turn?.content ?? '').join(' ')
    const claudeContainsLocal = claudeTurnTexts.includes(MARKER_LOCAL)
    metrics.claudeContainsLocalMarker = claudeContainsLocal

    // 7. Verify WS events carry the correct threadId
    // Drain all WS messages and check each chat.turn carries a threadId
    // that matches either the local or claude thread (no orphans)
    const allWsMessages = client.drainWs()
    const turnMessages = allWsMessages.filter((m: any) => m.type === 'chat.turn')
    metrics.wsTurnMessages = turnMessages.length

    const localThreadWsTurns = turnMessages.filter((m: any) => m.threadId === threadLocal.id)
    const claudeThreadWsTurns = turnMessages.filter((m: any) => m.threadId === threadClaude.id)
    const orphanWsTurns = turnMessages.filter(
      (m: any) => m.threadId !== threadLocal.id && m.threadId !== threadClaude.id
    )
    metrics.localWsTurns = localThreadWsTurns.length
    metrics.claudeWsTurns = claudeThreadWsTurns.length
    metrics.orphanWsTurns = orphanWsTurns.length

    // Verify WS turns for the local thread don't carry claude content
    const localWsContainsClaude = localThreadWsTurns.some((m: any) => (m.turn?.content ?? '').includes(MARKER_CLAUDE))
    const claudeWsContainsLocal = claudeThreadWsTurns.some((m: any) => (m.turn?.content ?? '').includes(MARKER_LOCAL))
    metrics.localWsContainsClaude = localWsContainsClaude
    metrics.claudeWsContainsLocal = claudeWsContainsLocal

    // 8. Verdict
    const sseIsolated = !localContainsClaude && !claudeContainsLocal
    const wsIsolated = !localWsContainsClaude && !claudeWsContainsLocal
    const noOrphans = orphanWsTurns.length === 0
    // At least one turn arrived per thread (both backends responded)
    const bothResponded = sseLocal.turns.length > 0 && sseClaude.turns.length > 0

    const passed = sseIsolated && wsIsolated && noOrphans && bothResponded

    return cleanup({
      passed,
      summary: passed
        ? `isolation OK — SSE: ✓ (${sseLocal.turns.length}/${sseClaude.turns.length} turns), ` +
          `WS: ✓ (${localThreadWsTurns.length}/${claudeThreadWsTurns.length} turns, 0 orphans)`
        : `isolation failed — SSE-leak=${!sseIsolated}, WS-leak=${!wsIsolated}, ` +
          `orphans=${orphanWsTurns.length}, responded=${bothResponded}`,
      metrics,
      samples: client.samples
    })
  }
}
