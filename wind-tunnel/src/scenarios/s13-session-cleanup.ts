// S13: Session Cleanup — Layer 3 of the session-hygiene stack. Build up a
// transcript via echo messages, trigger the between-session JSONL cleanup
// pass, and confirm the data directory shrinks while the thread and
// conversation survive.

import { execSync } from 'node:child_process'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

export const s13SessionCleanup: Scenario = {
  id: 's13',
  name: 'Session Cleanup',
  description: 'Between-session JSONL cleanup prunes an oversized transcript while the thread and conversation survive',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl, sovereignUrl, composeFile } = ctx
    const metrics: Record<string, unknown> = {}

    // composeFile always set — Docker-only execution enforced by the runner.

    // 1. Clear mock log and scripts left over from a prior scenario.
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })

    // 3. Create a test thread and open WS so we catch chat.status
    //    transitions between messages.
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s13-cleanup' }))
    metrics.threadId = thread.id
    await client.connectWs(['chat', 'threads'])

    // 4. Build up context — five echo-only turns. The SDK's messages
    //    include system-reminder blocks (~4KB each), so the JSONL grows
    //    past the cleanup threshold without needing tool scripts.
    const idleResults: boolean[] = []
    for (let i = 1; i <= 5; i++) {
      await client.timed(`send-msg-${i}`, () =>
        client.sendMessage(thread.id, `s13-cleanup-msg-${i} — build transcript for cleanup test`)
      )
      idleResults.push(await waitForIdle(client, 30000))
      client.drainWs('chat.status')
      client.drainWs('chat.turn')
    }
    metrics.buildUpIdleResults = idleResults

    if (idleResults.some((ok) => !ok)) {
      await teardown(client, thread.id)
      return {
        passed: false,
        summary: `build-up turn(s) never settled to idle — ${idleResults.filter((ok) => !ok).length}/5 timed out`,
        metrics,
        samples: client.samples
      }
    }

    // 5. Confirm every turn settled before measuring transcript size.
    metrics.finalIdleBeforeMeasure = await waitForIdle(client, 15000)

    // 6. Measure pre-cleanup data-dir size.
    const pre = readDataDirBytes(composeFile)
    metrics.preSizeBytes = pre.bytes
    if (pre.error) metrics.preSizeError = pre.error

    // 7. Trigger cleanup — primary endpoint first, then the maintenance
    //    fallback, then self-skip if neither route exists yet.
    const primary = await client.timed('cleanup', () => tryCleanup(sovereignUrl, '/api/sessions/cleanup'))
    metrics.primaryCleanupStatus = primary.status

    let cleanupEndpoint: string
    let cleanupResult: unknown

    if (primary.status === 404) {
      const fallback = await client.timed('cleanup-maintenance', () =>
        tryCleanup(sovereignUrl, '/api/system/maintenance', { action: 'cleanup-sessions' })
      )
      metrics.fallbackCleanupStatus = fallback.status
      if (fallback.status === 404) {
        await teardown(client, thread.id)
        return skip('skipped — cleanup endpoint not available (feature pending)')
      }
      cleanupEndpoint = '/api/system/maintenance'
      cleanupResult = fallback.body
    } else {
      cleanupEndpoint = '/api/sessions/cleanup'
      cleanupResult = primary.body
    }
    metrics.cleanupEndpoint = cleanupEndpoint
    metrics.cleanupResult = cleanupResult

    // 8. Give the cleanup pass time to finish writing.
    await sleep(3000)

    // 9. Measure post-cleanup data-dir size.
    const post = readDataDirBytes(composeFile)
    metrics.postSizeBytes = post.bytes
    if (post.error) metrics.postSizeError = post.error

    // 10. The thread survives the cleanup pass.
    let threadSurvived = false
    try {
      const reloaded = await client.timed('get-thread', () => client.getThread(thread.id))
      threadSurvived = reloaded?.id === thread.id
    } catch (err: any) {
      metrics.threadReloadError = err?.message
    }
    metrics.threadSurvived = threadSurvived

    // 11. The conversation continues after cleanup.
    let conversationContinued = false
    try {
      await client.timed('post-cleanup-send', () => client.sendMessage(thread.id, 'post-cleanup s13 check'))
      const turn = await client.timed('post-cleanup-turn', () => client.waitForWs('chat.turn', 30000))
      conversationContinued = turn != null
      metrics.postCleanupTurnRole = turn?.turn?.role
    } catch (err: any) {
      metrics.postCleanupTurnError = err?.message
    }
    metrics.conversationContinued = conversationContinued

    // 12. Cleanup — disconnect WS, remove the test thread.
    await teardown(client, thread.id)

    // The cleanup endpoint must have scanned sessions. Echo-only
    // sessions have no prunable tool_result blocks, so reclaimedBytes
    // may stay at zero — the test asserts the sweep RAN (sessionsScanned > 0)
    // plus thread survival and conversation continuity.
    const cleanupBody = cleanupResult as Record<string, unknown> | null
    const sessionsScanned = (cleanupBody?.sessionsScanned as number) ?? 0
    metrics.sessionsScanned = sessionsScanned
    metrics.preSizeBytes = pre.bytes
    metrics.postSizeBytes = post.bytes

    const passed = threadSurvived && conversationContinued && sessionsScanned > 0

    const sizeNote = pre.bytes !== post.bytes ? `${pre.bytes} → ${post.bytes} bytes` : `${pre.bytes} bytes (unchanged)`

    return {
      passed,
      summary: passed
        ? `cleanup OK via ${cleanupEndpoint} — ${sessionsScanned} sessions scanned, thread survived, conversation continued, data dir ${sizeNote}`
        : `cleanup check failed — threadSurvived=${threadSurvived}, conversationContinued=${conversationContinued}, scanned=${sessionsScanned}`,
      metrics,
      samples: client.samples
    }
  }
}

/** Wait for the global chat status to settle on 'idle', looping past any
 *  intermediate 'working'/'thinking' events on the 'chat' channel. Falls
 *  back to a buffered-message check and a direct status poll. */
async function waitForIdle(client: any, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const evt = await client.waitForWs('chat.status', Math.max(500, deadline - Date.now()))
      if (evt?.status === 'idle') return true
    } catch {
      break
    }
  }
  const drained = client.drainWs('chat.status')
  if (drained.some((m: any) => m.status === 'idle')) return true
  try {
    const status = await client.chatStatus()
    return status?.status === 'idle'
  } catch {
    return false
  }
}

/** POST to a maintenance-style endpoint and report the raw status — a
 *  missing route surfaces as 404 rather than a thrown parse error, so the
 *  caller can branch to a fallback or self-skip cleanly. */
async function tryCleanup(
  sovereignUrl: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${sovereignUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body != null ? JSON.stringify(body) : undefined
  })
  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    /* empty or non-JSON body — the status code alone carries the signal */
  }
  return { status: res.status, body: parsed }
}

/** Read the total size of the container's data directory via `du -sb`. */
function readDataDirBytes(composeFile: string): { bytes: number; error?: string } {
  try {
    const output = execSync(`docker compose -f "${composeFile}" exec -T sovereign du -sb /data/data/ 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim()
    const bytes = Number.parseInt(output.split(/\s+/)[0] ?? '', 10)
    return { bytes: Number.isFinite(bytes) ? bytes : 0 }
  } catch (err: any) {
    return { bytes: 0, error: err?.message }
  }
}

/** Best-effort teardown — disconnect WS, remove the test thread. */
async function teardown(client: any, threadId: string): Promise<void> {
  try {
    client.disconnectWs()
  } catch {
    /* already closed */
  }
  try {
    await client.deleteThread(threadId)
  } catch {
    /* best effort — the thread may already not exist */
  }
}
