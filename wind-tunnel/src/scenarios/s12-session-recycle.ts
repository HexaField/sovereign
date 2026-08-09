// S12: Session Recycle — interrupt Query, prune JSONL, resume with reduced
// context (Layer 2 of plans/context-management.md).
//
// When accumulated context crosses a threshold, Sovereign interrupts the SDK
// Query, prunes the JSONL transcript via cozempic, then resumes from the
// pruned file. The conversation continues with a smaller token footprint.
//
// This scenario builds up ~12KB of tool-result context across three
// Bash-heavy turns, reads the context budget, triggers a recycle, then
// checks the budget dropped and the conversation still responds. Self-skips
// on 404 when the recycle endpoints don't exist yet.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import type { SovereignClient } from '../client.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

/** Detects a 404 status inside a client error message (`GET path → 404 ...`). */
function is404(err: any): boolean {
  return String(err?.message ?? '').includes('→ 404')
}

/** Pulls a token count out of whatever shape the context-budget response carries. */
function extractTokens(data: any): number {
  const raw = data?.tokens ?? data?.totalTokens ?? data?.contextTokens ?? data?.session?.contextTokens ?? 0
  return Number(raw) || 0
}

/** Waits for a 'chat.status' WS message reporting idle, stepping past interim
 *  states (working/thinking) until one lands or the timeout elapses. Loops
 *  on `waitForWs` rather than pre-scanning the buffer — a resolved wait
 *  leaves its message behind in the client's buffer, so a buffer pre-scan
 *  would catch a stale idle from an earlier turn instead of this one. */
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

/** Polls the context-budget endpoint until tokens drop below `below`, or timeout. */
async function pollForDrop(
  client: SovereignClient,
  threadId: string,
  below: number,
  timeoutMs: number
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const data = await client.get(`/api/chat/context-budget?threadId=${threadId}`)
      const tokens = extractTokens(data)
      if (tokens < below) return tokens
    } catch {
      /* transient — retry */
    }
    await sleep(1000)
  }
  return null
}

export const s12SessionRecycle: Scenario = {
  id: 's12',
  name: 'Session Recycle',
  description: 'Context threshold triggers interrupt, JSONL prune, and resume with reduced context',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Clear mock log + scripts
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // 2. Create a test thread
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s12-recycle' }))
    metrics.threadId = thread.id

    // 3. Connect WS
    await client.connectWs(['chat', 'threads'])

    const finish = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // 4. Build up context — three Bash-heavy turns, each ~4KB of tool
    //    output, so the transcript accumulates ~12KB of tool results.
    const contextBuildIdle: boolean[] = []
    for (let i = 1; i <= 3; i++) {
      const pattern = `s12-recycle-msg-${i}`
      await fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern,
          toolUse: { id: `toolu_s12_${i}`, name: 'Bash', input: { command: 'seq 1 800' } },
          once: true,
          needsTools: true
        })
      })
      await client.timed(`context-send-${i}`, () => client.sendMessage(thread.id, `${pattern} — run the bash tool`))
      const idle = await client.timed(`context-idle-${i}`, () => waitForIdleStatus(client, 15000))
      contextBuildIdle.push(idle)
      // Flush this turn's status/turn events. A resolved wait leaves its
      // message behind in the buffer (see waitForIdleStatus), so without
      // this, a leftover idle status short-circuits the next iteration's
      // wait, and a leftover chat.turn shadows step 9's post-recycle wait.
      client.drainWs('chat.status')
      client.drainWs('chat.turn')
    }
    metrics.contextBuildIdle = contextBuildIdle

    // 5. Pre-recycle context budget
    let preTokens = 0
    try {
      const pre = await client.timed('pre-context-budget', () =>
        client.get(`/api/chat/context-budget?threadId=${thread.id}`)
      )
      preTokens = extractTokens(pre)
      metrics.preTokens = preTokens
      metrics.preBudget = pre
    } catch (err: any) {
      if (is404(err)) return finish(skip('skipped — context budget endpoint not available (feature pending)'))
      return finish({
        passed: false,
        summary: `context-budget request failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }

    // 6. Trigger recycle
    try {
      const recycleResp = await client.timed('trigger-recycle', () => client.post(`/api/threads/${thread.id}/recycle`))
      metrics.recycleResponse = recycleResp
    } catch (err: any) {
      if (is404(err)) return finish(skip('skipped — recycle endpoint not available (feature pending)'))
      return finish({
        passed: false,
        summary: `recycle request failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }

    // 7. Wait for recycle to complete — a WS signal, or a budget-poll fallback.
    let recycleSignalled = false
    try {
      const evt = await client.timed('wait-session-recycled', () => client.waitForWs('session.recycled', 30000))
      recycleSignalled = true
      metrics.recycledEvent = evt
    } catch {
      const dropped = await client.timed('poll-context-drop', () => pollForDrop(client, thread.id, preTokens, 30000))
      recycleSignalled = dropped != null
      metrics.polledPostTokens = dropped
    }
    metrics.recycleSignalled = recycleSignalled

    // 8. Post-recycle context budget
    let postTokens = 0
    try {
      const post = await client.timed('post-context-budget', () =>
        client.get(`/api/chat/context-budget?threadId=${thread.id}`)
      )
      postTokens = extractTokens(post)
      metrics.postTokens = postTokens
      metrics.postBudget = post
    } catch (err: any) {
      return finish({
        passed: false,
        summary: `post-recycle context-budget request failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }

    // 9. Verify the conversation continues past the recycle
    let postRecycleTurnOk = false
    try {
      await client.timed('post-recycle-send', () => client.sendMessage(thread.id, 'post-recycle s12 verification'))
      const turn = await client.timed('post-recycle-turn', () => client.waitForWs('chat.turn', 30000))
      postRecycleTurnOk = turn != null
      metrics.postRecycleTurn = turn
    } catch (err: any) {
      metrics.postRecycleTurnError = err?.message
    }
    metrics.postRecycleTurnOk = postRecycleTurnOk

    // 10. Assertions — context shrank, and the session kept responding.
    const contextReduced = postTokens < preTokens
    metrics.contextReduced = contextReduced
    const passed = contextReduced && postRecycleTurnOk

    return finish({
      passed,
      summary: passed
        ? `recycle OK — tokens ${preTokens} → ${postTokens}, conversation continued`
        : `recycle failed — tokens ${preTokens} → ${postTokens} (reduced=${contextReduced}), post-recycle turn ok=${postRecycleTurnOk}`,
      metrics,
      samples: client.samples
    })
  }
}
