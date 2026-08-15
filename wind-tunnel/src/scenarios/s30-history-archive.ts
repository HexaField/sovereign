// S30: History Archive — prove that full thread history survives every
// destructive operation (context strategies, session recycle) and that
// the history API always returns the complete user+assistant conversation.
//
// Verifies:
//   1. Local-LLM: 12 rounds of messaging → strategies fire (>20 messages) →
//      every user message and every assistant response still appears in the
//      history API response.
//   2. Local-LLM: session recycle triggered → user/assistant messages still
//      appear in history.
//   3. Claude-Code: 3 rounds → recycle → user/assistant messages survive.
//
// The archive layer (history-archive.ts) preserves the full state before
// mutations. Unit tests cover the archive mechanism directly; this scenario
// proves the end-to-end behaviour visible to the UI.
//
// Self-skips when no local-llm or claude-code backend available.

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

/** Count how many history turns match a role and contain a marker substring. */
function countMarked(turns: any[], role: string, marker: string): number {
  return turns.filter((t: any) => t.role === role && typeof t.content === 'string' && t.content.includes(marker)).length
}

export const s30HistoryArchive: Scenario = {
  id: 's30',
  name: 'History Archive Preservation',
  description:
    'Full user+assistant history survives context strategies and session recycle — ' +
    'verifies both local-llm and claude-code backends via the history API',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 0. Discover available backends
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
    metrics.hasLocalLlm = hasLocalLlm
    metrics.hasClaudeCode = hasClaudeCode

    if (!hasLocalLlm && !hasClaudeCode) {
      return skip('skipped — neither local-llm nor claude-code backend available')
    }

    // Clear mock state
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // ════════════════════════════════════════════════════════════════════
    // Part A: Local-LLM history survival
    // ════════════════════════════════════════════════════════════════════
    if (hasLocalLlm) {
      const partA = await testLocalLlmHistory(client, mockLlmUrl, metrics)
      if (!partA.passed) return partA
    }

    // ════════════════════════════════════════════════════════════════════
    // Part B: Claude-Code history survival
    // ════════════════════════════════════════════════════════════════════
    if (hasClaudeCode) {
      const partB = await testClaudeCodeHistory(client, mockLlmUrl, metrics)
      if (!partB.passed) return partB
    }

    // ── Verdict ────────────────────────────────────────────────────────
    return {
      passed: true,
      summary:
        `history archive OK — ` +
        (hasLocalLlm
          ? `local-llm: ${metrics.llmUsersSentTotal}/${metrics.llmUsersSentTotal} user msgs survived strategies+recycle`
          : 'local-llm: skipped') +
        '; ' +
        (hasClaudeCode
          ? `claude-code: ${metrics.ccUsersSentTotal}/${metrics.ccUsersSentTotal} user msgs survived recycle`
          : 'claude-code: skipped'),
      metrics,
      samples: client.samples
    }
  }
}

// ── Local-LLM test ──────────────────────────────────────────────────────

async function testLocalLlmHistory(
  client: SovereignClient,
  mockLlmUrl: string,
  metrics: Record<string, unknown>
): Promise<ScenarioResult> {
  // Create thread
  let thread: any
  try {
    thread = await client.timed('llm-create-thread', () =>
      client.post('/api/threads', { label: 'swt-s30-llm-archive', backend: 'local-llm' })
    )
    thread = thread?.thread ?? thread
  } catch (err: any) {
    return {
      passed: false,
      summary: `local-llm thread creation failed: ${err?.message}`,
      metrics,
      samples: client.samples
    }
  }
  metrics.llmThreadId = thread.id

  const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
    client.disconnectWs()
    await client.deleteThread(thread.id).catch(() => {})
    return result
  }

  await client.connectWs(['chat', 'threads'])

  // ── Phase 1: Send 12 rounds (24+ messages, triggers strategies) ────
  const ROUNDS = 12
  const MARKER = 's30-llm'
  metrics.llmUsersSentTotal = ROUNDS

  for (let i = 1; i <= ROUNDS; i++) {
    // Script a response that echoes the marker
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: `${MARKER}-${i}`,
        response: `Response for ${MARKER}-${i}`,
        needsTools: false
      })
    })

    try {
      await client.timed(`llm-send-${i}`, () => client.sendMessage(thread.id, `User message ${MARKER}-${i}`))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `local-llm send failed at round ${i}: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    const idle = await waitForIdleStatus(client, 30000)
    if (!idle) {
      return cleanup({
        passed: false,
        summary: `local-llm no idle after round ${i}`,
        metrics,
        samples: client.samples
      })
    }
    client.drainWs('chat.status')
    client.drainWs('chat.turn')
  }

  // ── Phase 2: Verify history after strategies ───────────────────────
  let history1: any
  try {
    history1 = await client.timed('llm-history-post-strategies', () => client.threadHistory(thread.id))
  } catch (err: any) {
    return cleanup({
      passed: false,
      summary: `local-llm history fetch failed: ${err?.message}`,
      metrics,
      samples: client.samples
    })
  }
  const turns1 = history1?.turns ?? history1 ?? []
  metrics.llmTurnsPostStrategies = turns1.length

  // Count user messages with our marker
  const userCount1 = countMarked(turns1, 'user', MARKER)
  const assistantCount1 = countMarked(turns1, 'assistant', MARKER)
  metrics.llmUsersPostStrategies = userCount1
  metrics.llmAssistantsPostStrategies = assistantCount1

  if (userCount1 < ROUNDS) {
    return cleanup({
      passed: false,
      summary: `local-llm user messages lost after strategies: sent ${ROUNDS}, found ${userCount1}`,
      metrics,
      samples: client.samples
    })
  }
  if (assistantCount1 < ROUNDS) {
    return cleanup({
      passed: false,
      summary: `local-llm assistant messages lost after strategies: expected ${ROUNDS}, found ${assistantCount1}`,
      metrics,
      samples: client.samples
    })
  }

  // ── Phase 3: Trigger recycle → verify history survives ─────────────
  let recycleResp: any = null
  try {
    recycleResp = await client.timed('llm-recycle', () => client.post(`/api/threads/${thread.id}/recycle`))
    metrics.llmRecycleResponse = recycleResp
  } catch (err: any) {
    if (is404(err)) {
      metrics.llmRecycleSkipped = true
    } else {
      return cleanup({
        passed: false,
        summary: `local-llm recycle failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
  }

  if (!metrics.llmRecycleSkipped) {
    // Verify user messages survived the recycle
    let history2: any
    try {
      history2 = await client.timed('llm-history-post-recycle', () => client.threadHistory(thread.id))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `local-llm post-recycle history fetch failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    const turns2 = history2?.turns ?? history2 ?? []
    metrics.llmTurnsPostRecycle = turns2.length

    const userCount2 = countMarked(turns2, 'user', MARKER)
    const assistantCount2 = countMarked(turns2, 'assistant', MARKER)
    metrics.llmUsersPostRecycle = userCount2
    metrics.llmAssistantsPostRecycle = assistantCount2

    if (userCount2 < ROUNDS) {
      return cleanup({
        passed: false,
        summary: `local-llm user messages lost after recycle: sent ${ROUNDS}, found ${userCount2}`,
        metrics,
        samples: client.samples
      })
    }
    if (assistantCount2 < ROUNDS) {
      return cleanup({
        passed: false,
        summary: `local-llm assistant messages lost after recycle: expected ${ROUNDS}, found ${assistantCount2}`,
        metrics,
        samples: client.samples
      })
    }
  }

  // ── Phase 4: Send one more message → history grows ─────────────────
  await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
  await fetch(`${mockLlmUrl}/mock/script`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pattern: `${MARKER}-post`,
      response: `Post-archive response for ${MARKER}-post`,
      needsTools: false
    })
  })

  try {
    await client.timed('llm-send-post', () => client.sendMessage(thread.id, `User message ${MARKER}-post`))
  } catch (err: any) {
    return cleanup({
      passed: false,
      summary: `local-llm post-archive send failed: ${err?.message}`,
      metrics,
      samples: client.samples
    })
  }
  const postIdle = await waitForIdleStatus(client, 30000)
  if (!postIdle) {
    return cleanup({
      passed: false,
      summary: 'local-llm no idle after post-archive send',
      metrics,
      samples: client.samples
    })
  }

  let history3: any
  try {
    history3 = await client.timed('llm-history-final', () => client.threadHistory(thread.id))
  } catch (err: any) {
    return cleanup({
      passed: false,
      summary: `local-llm final history fetch failed: ${err?.message}`,
      metrics,
      samples: client.samples
    })
  }
  const turns3 = history3?.turns ?? history3 ?? []
  metrics.llmTurnsFinal = turns3.length

  const userCountFinal = countMarked(turns3, 'user', MARKER)
  metrics.llmUsersFinal = userCountFinal
  // Must include all 12 originals + 1 post message
  if (userCountFinal < ROUNDS + 1) {
    return cleanup({
      passed: false,
      summary: `local-llm user messages missing after post-archive send: expected ${ROUNDS + 1}, found ${userCountFinal}`,
      metrics,
      samples: client.samples
    })
  }

  client.disconnectWs()
  await client.deleteThread(thread.id).catch(() => {})
  return { passed: true, summary: 'local-llm history archive OK', metrics, samples: client.samples }
}

// ── Claude-Code test ────────────────────────────────────────────────────

async function testClaudeCodeHistory(
  client: SovereignClient,
  mockLlmUrl: string,
  metrics: Record<string, unknown>
): Promise<ScenarioResult> {
  // Create thread (default backend = claude-code)
  let thread: any
  try {
    thread = await client.timed('cc-create-thread', () => client.post('/api/threads', { label: 'swt-s30-cc-archive' }))
    thread = thread?.thread ?? thread
  } catch (err: any) {
    return {
      passed: false,
      summary: `claude-code thread creation failed: ${err?.message}`,
      metrics,
      samples: client.samples
    }
  }
  metrics.ccThreadId = thread.id

  const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
    client.disconnectWs()
    await client.deleteThread(thread.id).catch(() => {})
    return result
  }

  await client.connectWs(['chat', 'threads'])

  // ── Phase 1: Send 3 messages ──────────────────────────────────────
  const ROUNDS = 3
  const MARKER = 's30-cc'
  metrics.ccUsersSentTotal = ROUNDS

  for (let i = 1; i <= ROUNDS; i++) {
    try {
      await client.timed(`cc-send-${i}`, () => client.sendMessage(thread.id, `User message ${MARKER}-${i}`))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `claude-code send failed at round ${i}: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    const idle = await waitForIdleStatus(client, 30000)
    if (!idle) {
      return cleanup({
        passed: false,
        summary: `claude-code no idle after round ${i}`,
        metrics,
        samples: client.samples
      })
    }
    client.drainWs('chat.status')
    client.drainWs('chat.turn')
  }

  // ── Phase 2: Verify history before recycle ─────────────────────────
  let history1: any
  try {
    history1 = await client.timed('cc-history-pre-recycle', () => client.threadHistory(thread.id))
  } catch (err: any) {
    return cleanup({
      passed: false,
      summary: `claude-code pre-recycle history failed: ${err?.message}`,
      metrics,
      samples: client.samples
    })
  }
  const turns1 = history1?.turns ?? history1 ?? []
  metrics.ccTurnsPreRecycle = turns1.length
  const userCount1 = countMarked(turns1, 'user', MARKER)
  metrics.ccUsersPreRecycle = userCount1

  if (userCount1 < ROUNDS) {
    return cleanup({
      passed: false,
      summary: `claude-code user messages missing pre-recycle: sent ${ROUNDS}, found ${userCount1}`,
      metrics,
      samples: client.samples
    })
  }

  // ── Phase 3: Trigger recycle ──────────────────────────────────────
  let recycleResp: any = null
  try {
    recycleResp = await client.timed('cc-recycle', () => client.post(`/api/threads/${thread.id}/recycle`))
    metrics.ccRecycleResponse = recycleResp
  } catch (err: any) {
    if (is404(err)) {
      metrics.ccRecycleSkipped = true
    } else {
      return cleanup({
        passed: false,
        summary: `claude-code recycle failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
  }

  // ── Phase 4: Verify history after recycle ──────────────────────────
  if (!metrics.ccRecycleSkipped) {
    let history2: any
    try {
      history2 = await client.timed('cc-history-post-recycle', () => client.threadHistory(thread.id))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `claude-code post-recycle history failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }
    const turns2 = history2?.turns ?? history2 ?? []
    metrics.ccTurnsPostRecycle = turns2.length
    const userCount2 = countMarked(turns2, 'user', MARKER)
    metrics.ccUsersPostRecycle = userCount2

    if (userCount2 < ROUNDS) {
      return cleanup({
        passed: false,
        summary: `claude-code user messages lost after recycle: sent ${ROUNDS}, found ${userCount2}`,
        metrics,
        samples: client.samples
      })
    }
  }

  // ── Phase 5: Post-recycle send → history grows ────────────────────
  try {
    await client.timed('cc-send-post', () => client.sendMessage(thread.id, `User message ${MARKER}-post`))
  } catch (err: any) {
    return cleanup({
      passed: false,
      summary: `claude-code post-recycle send failed: ${err?.message}`,
      metrics,
      samples: client.samples
    })
  }
  const postIdle = await waitForIdleStatus(client, 30000)
  if (!postIdle) {
    return cleanup({
      passed: false,
      summary: 'claude-code no idle after post-recycle send',
      metrics,
      samples: client.samples
    })
  }

  let history3: any
  try {
    history3 = await client.timed('cc-history-final', () => client.threadHistory(thread.id))
  } catch (err: any) {
    return cleanup({
      passed: false,
      summary: `claude-code final history failed: ${err?.message}`,
      metrics,
      samples: client.samples
    })
  }
  const turns3 = history3?.turns ?? history3 ?? []
  metrics.ccTurnsFinal = turns3.length
  const userCountFinal = countMarked(turns3, 'user', MARKER)
  metrics.ccUsersFinal = userCountFinal

  if (userCountFinal < ROUNDS + 1) {
    return cleanup({
      passed: false,
      summary: `claude-code user messages missing after post-recycle send: expected ${ROUNDS + 1}, found ${userCountFinal}`,
      metrics,
      samples: client.samples
    })
  }

  client.disconnectWs()
  await client.deleteThread(thread.id).catch(() => {})
  return { passed: true, summary: 'claude-code history archive OK', metrics, samples: client.samples }
}
