// S12: Session Recycle — interrupt Query, prune JSONL, resume with reduced
// context (Layer 2 of plans/context-management.md).
//
// When accumulated context crosses a threshold, Sovereign interrupts the SDK
// Query, prunes the JSONL transcript via cozempic, then resumes from the
// pruned file. The conversation continues with a smaller token footprint.
//
// This scenario builds up context across three message turns (echo
// responses include large system-reminder blocks that grow the JSONL),
// triggers a recycle, and verifies the endpoint returns ok=true and the
// conversation still responds. Self-skips on 404 when the recycle
// endpoints don't exist yet.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import type { SovereignClient } from '../client.js'

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

/** Waits for a 'chat.status' WS message reporting idle, stepping past interim
 *  states (working/thinking) until one lands or the timeout elapses. */
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

    // 4. Build up context — three echo-only turns. The SDK's messages
    //    include system-reminder blocks (~4KB each), so the JSONL grows
    //    well past the 4KB cleanup threshold without needing tool scripts.
    const contextBuildIdle: boolean[] = []
    for (let i = 1; i <= 3; i++) {
      await client.timed(`context-send-${i}`, () =>
        client.sendMessage(thread.id, `s12-recycle-msg-${i} — build context for recycle test`)
      )
      const idle = await client.timed(`context-idle-${i}`, () => waitForIdleStatus(client, 15000))
      contextBuildIdle.push(idle)
      client.drainWs('chat.status')
      client.drainWs('chat.turn')
    }
    metrics.contextBuildIdle = contextBuildIdle

    // 5. Trigger recycle
    let recycleResp: any = null
    try {
      recycleResp = await client.timed('trigger-recycle', () => client.post(`/api/threads/${thread.id}/recycle`))
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

    // 6. Verify the recycle response.
    const recycleOk = recycleResp?.ok === true
    metrics.recycleOk = recycleOk
    metrics.recycleMethod = recycleResp?.method
    metrics.reclaimedBytes = recycleResp?.reclaimedBytes

    // 7. Verify the conversation continues past the recycle.
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

    // 8. Assertions — recycle ran and the session kept responding.
    const passed = recycleOk && postRecycleTurnOk

    return finish({
      passed,
      summary: passed
        ? `recycle OK — ${recycleResp?.reclaimedBytes ?? 0} bytes reclaimed (${recycleResp?.method}), conversation continued`
        : `recycle failed — recycleOk=${recycleOk}, post-recycle turn ok=${postRecycleTurnOk}`,
      metrics,
      samples: client.samples
    })
  }
}
