// S33: Slash Commands — Server Endpoints
//
// Proves the server-side components of the slash command picker feature:
//
// 1. GET /api/llm/slots — The prefill-progress proxy returns a safe response:
//    503 + { error: string } when no llama-server is configured/reachable,
//    or 200 + slot array when the server is up. Both are valid; what the
//    scenario enforces is that the response is never a bare non-JSON error.
//
// 2. POST /api/ad4m/command — The slash command execution endpoint validates
//    its input before touching any AD4M state:
//    • empty body               → 400 + { ok: false, error: string }
//    • unknown action value     → 400 + { ok: false, error: "Unknown action…" }
//    • valid fields, no client  → not 500 (graceful error, not crash)
//
// 3. SSE /api/threads/:id/events — lastError replay: when a live-state file
//    carries lastError, the SSE endpoint replays an 'error' event with
//    replay:true on the next connect — proving the persistent-error-across-
//    reload path works end-to-end.

import { execSync } from 'node:child_process'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

/** Consume SSE events from `url` until `matcher` matches or `timeoutMs` elapses. */
async function collectSSEUntil(
  url: string,
  matcher: (data: unknown) => boolean,
  timeoutMs: number
): Promise<unknown[]> {
  const collected: unknown[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      clearTimeout(timer)
      return collected
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6)) as unknown
          collected.push(data)
          if (matcher(data)) {
            clearTimeout(timer)
            controller.abort()
            reader.cancel().catch(() => {})
            return collected
          }
        } catch {
          /* skip non-JSON lines */
        }
      }
    }

    reader.cancel().catch(() => {})
  } catch (err: unknown) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      collected.push({ _sseError: (err as { message?: string })?.message })
    }
  }

  clearTimeout(timer)
  return collected
}

export const s33SlashCommands: Scenario = {
  id: 's33',
  name: 'Slash Commands — Server Endpoints',
  description: 'LLM slots proxy shape, /ad4m/command validation, SSE lastError replay',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, composeFile, sovereignUrl } = ctx
    const metrics: Record<string, unknown> = {}
    const failures: string[] = []

    // ── 1. GET /api/llm/slots — response shape ────────────────────────────
    // The wind tunnel has no llama-server, so 503 + { error: string } is the
    // expected response. 200 + slot array is also acceptable (future setups).
    // What is NOT acceptable: a non-JSON response or an unexpected status code.
    let slotsStatus = 0
    let slotsBody: unknown = null
    try {
      const res = await fetch(`${sovereignUrl}/api/llm/slots`)
      slotsStatus = res.status
      slotsBody = await res.json()
    } catch (err: unknown) {
      metrics.slotsParseError = (err as { message?: string })?.message
    }
    metrics.slotsStatus = slotsStatus
    metrics.slotsBody = slotsBody

    const slotsBodyObj = slotsBody as Record<string, unknown> | null
    const slotsValid =
      (slotsStatus === 200 && Array.isArray(slotsBody)) ||
      (slotsStatus === 503 && typeof slotsBodyObj?.error === 'string')

    if (!slotsValid) {
      failures.push(
        `GET /api/llm/slots: expected 200+array or 503+{error:string}, got ${slotsStatus} body=${JSON.stringify(slotsBody)}`
      )
    }

    // ── 2a. POST /api/ad4m/command — empty body → 400 ─────────────────────
    let cmd400Status = 0
    let cmd400Body: Record<string, unknown> | null = null
    {
      const res = await fetch(`${sovereignUrl}/api/ad4m/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      })
      cmd400Status = res.status
      cmd400Body = (await res.json().catch(() => null)) as Record<string, unknown> | null
    }
    metrics.cmd400Status = cmd400Status
    metrics.cmd400Body = cmd400Body

    if (cmd400Status !== 400 || cmd400Body?.ok !== false || typeof cmd400Body?.error !== 'string') {
      failures.push(
        `POST /api/ad4m/command (empty body): expected 400+{ok:false,error:string}, got ${cmd400Status} ok=${cmd400Body?.ok}`
      )
    }

    // ── 2b. Unknown action → 400 + "Unknown action" in error string ───────
    let cmdBadStatus = 0
    let cmdBadBody: Record<string, unknown> | null = null
    {
      const res = await fetch(`${sovereignUrl}/api/ad4m/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'teleport', url: 'neighbourhood://test', threadKey: 'swt-k' })
      })
      cmdBadStatus = res.status
      cmdBadBody = (await res.json().catch(() => null)) as Record<string, unknown> | null
    }
    metrics.cmdBadStatus = cmdBadStatus
    metrics.cmdBadBody = cmdBadBody

    const cmdBadErrorMsg = String(cmdBadBody?.error ?? '')
    if (cmdBadStatus !== 400 || cmdBadBody?.ok !== false || !cmdBadErrorMsg.includes('Unknown action')) {
      failures.push(
        `POST /api/ad4m/command (bad action): expected 400+{ok:false,error:"Unknown action…"}, ` +
          `got ${cmdBadStatus} error="${cmdBadErrorMsg}"`
      )
    }

    // ── 2c. Valid fields, no AD4M client → must not return 500 ────────────
    let cmdNoClientStatus = 0
    let cmdNoClientBody: Record<string, unknown> | null = null
    {
      const res = await fetch(`${sovereignUrl}/api/ad4m/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'watch', url: 'neighbourhood://wind-tunnel-test', threadKey: 'swt-k' })
      })
      cmdNoClientStatus = res.status
      cmdNoClientBody = (await res.json().catch(() => null)) as Record<string, unknown> | null
    }
    metrics.cmdNoClientStatus = cmdNoClientStatus
    metrics.cmdNoClientBody = cmdNoClientBody

    if (cmdNoClientStatus === 500) {
      failures.push(
        `POST /api/ad4m/command (no AD4M client): must not 500-crash, got 500 body=${JSON.stringify(cmdNoClientBody)}`
      )
    }
    if (cmdNoClientBody?.ok === true) {
      failures.push('POST /api/ad4m/command (no AD4M client): must not return ok:true when no client available')
    }

    // ── 3. SSE lastError replay ───────────────────────────────────────────
    // Inject a synthetic lastError via docker exec, then connect SSE and
    // verify the 'error' event with replay:true arrives on reconnect.
    // The live-state file lives at SOVEREIGN_DATA_DIR/chat/live-state/<id>.json
    // (SOVEREIGN_DATA_DIR = /data/data inside the container).
    let thread: { id: string } | null = null
    let sseReplayOk = false
    let sseReplayNote = ''

    try {
      thread = (await client.timed('create-thread', () => client.createThread({ label: 'swt-s33-slash' }))) as {
        id: string
      }
      metrics.threadId = thread.id

      // Write synthetic live-state with lastError via docker exec stdin
      const liveStatePath = `/data/data/chat/live-state/${thread.id}.json`
      const liveStateJson = JSON.stringify({ lastError: 'swt-s33 synthetic backend error' })

      try {
        execSync(
          `docker compose -f "${composeFile}" exec -T sovereign sh -c ` +
            `'mkdir -p /data/data/chat/live-state && cat > ${liveStatePath}'`,
          { input: liveStateJson, encoding: 'utf-8', timeout: 5000 }
        )
        metrics.liveStateWritten = true
      } catch (err: unknown) {
        sseReplayNote = `live-state write failed: ${(err as { message?: string })?.message}`
        metrics.liveStateWriteError = (err as { message?: string })?.message
      }

      if (!sseReplayNote) {
        // Connect SSE and wait for the replay error event (8s generous timeout)
        const sseUrl = `${sovereignUrl}/api/threads/${encodeURIComponent(thread.id)}/events`
        const events = await collectSSEUntil(
          sseUrl,
          (d) => {
            const obj = d as Record<string, unknown>
            return obj.replay === true && obj.error !== undefined
          },
          8000
        )

        metrics.sseEventCount = events.length
        const replayEvent = (events as Record<string, unknown>[]).find(
          (d) => d.replay === true && d.error !== undefined
        )
        metrics.replayEvent = replayEvent ?? null
        sseReplayOk = replayEvent !== undefined

        if (!sseReplayOk) {
          sseReplayNote = `no replay error event received in ${events.length} event(s)`
          failures.push(`SSE lastError replay: ${sseReplayNote}`)
        } else {
          // Verify the error text matches what we wrote
          const replayText = String(replayEvent?.error ?? '')
          metrics.replayText = replayText
          if (!replayText.includes('swt-s33')) {
            failures.push(`SSE lastError replay: error text mismatch — expected "swt-s33…", got "${replayText}"`)
            sseReplayOk = false
          }
        }
      }
    } catch (err: unknown) {
      sseReplayNote = (err as { message?: string })?.message ?? String(err)
      failures.push(`SSE lastError replay: ${sseReplayNote}`)
    }

    metrics.sseReplayOk = sseReplayOk
    if (sseReplayNote) metrics.sseReplayNote = sseReplayNote

    // Cleanup
    if (thread) {
      try {
        await client.deleteThread(thread.id)
      } catch {
        /* ignore — best-effort cleanup */
      }
    }

    const passed = failures.length === 0
    return {
      passed,
      summary: passed
        ? `OK — slots:${slotsStatus} cmd:400×2 no-client:${cmdNoClientStatus} sse-replay:${sseReplayOk ? 'OK' : 'skipped'}`
        : `FAILED — ${failures.join('; ')}`,
      metrics,
      samples: client.samples
    }
  }
}
