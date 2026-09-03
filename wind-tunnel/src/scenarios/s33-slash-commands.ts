// S33: Slash Commands — Server Endpoints
//
// Proves the server-side components of the slash command picker feature:
//
// 1. GET /api/llm/slots — The prefill-progress proxy returns a safe response:
//    503 + { error: string } when no llama-server is configured/reachable,
//    or 200 + slot array when the server is up. Both are valid; what the
//    scenario enforces is that the response is always valid JSON.
//
// 2. POST /api/ad4m/command — The slash command execution endpoint validates
//    its input before touching any AD4M state:
//    • empty body               → 400 + { ok: false, error: string }
//    • unknown action value     → 400 + { ok: false, error: "Unknown action…" }
//    • valid fields, no client  → not 500 (graceful error, not crash)
//    Self-skips when AD4M routes are not mounted (no --ad4m flag).
//
// 3. SSE /api/threads/:id/events — The per-thread event stream:
//    a. Endpoint is reachable (returns 200) for a valid thread.
//    b. After a chat roundtrip, SSE emits a working/thinking and then idle
//       event. This proves the SSE infrastructure that backs the client's
//       live-state display works end-to-end.
//
// Note: the SSE endpoint only replays non-idle status on reconnect (idle is
// the default; replaying it would be redundant). A fresh thread's SSE stream
// holds open waiting for events — there is no initial "status:idle" push.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

/** Consume SSE events from `url` until `matcher` matches or `timeoutMs` elapses.
 *  Returns all collected events (including the one that triggered the match). */
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
  description: 'LLM slots proxy shape, /ad4m/command validation, SSE live-state stream',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl, sovereignUrl } = ctx
    const metrics: Record<string, unknown> = {}
    const failures: string[] = []

    // ── 1. GET /api/llm/slots — response shape ────────────────────────────
    // The wind tunnel has no llama-server, so 503 + { error: string } is the
    // expected response. 200 + slot array is also acceptable (future setups).
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

    // ── 2. POST /api/ad4m/command — validation ────────────────────────────
    // Self-skip when AD4M routes are not mounted (returns 404 on the status
    // endpoint). The --ad4m flag is required to mount the AD4M module.
    let ad4mMounted = false
    {
      const probe = await fetch(`${sovereignUrl}/api/ad4m/status`)
      ad4mMounted = probe.status !== 404
      metrics.ad4mMounted = ad4mMounted
    }

    if (!ad4mMounted) {
      metrics.ad4mCommandSkipped = 'AD4M routes not mounted (run with --ad4m to enable)'
    } else {
      // 2a. Empty body → 400 + { ok: false, error: string }
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

      // 2b. Unknown action → 400 + "Unknown action" in error string
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

      // 2c. Valid fields, no AD4M client → must not return 500
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
    }

    // ── 3. SSE /api/threads/:id/events ───────────────────────────────────
    let thread: { id: string } | null = null
    let sseReachable = false
    let sseCycleOk = false

    try {
      thread = (await client.timed('create-thread', () => client.createThread({ label: 'swt-s33-slash' }))) as {
        id: string
      }
      metrics.threadId = thread.id

      const sseUrl = `${sovereignUrl}/api/threads/${encodeURIComponent(thread.id)}/events`

      // 3a. SSE endpoint is reachable for a valid thread.
      // The SSE endpoint returns 200 immediately and holds the connection open;
      // we abort after getting headers — we just need the status code.
      {
        const ctrl = new AbortController()
        const probeRes = await fetch(sseUrl, { signal: ctrl.signal }).catch(() => null)
        ctrl.abort()
        sseReachable = probeRes?.status === 200
        metrics.sseStatus = probeRes?.status ?? 0
        if (!sseReachable) {
          failures.push(`SSE endpoint: expected 200, got ${probeRes?.status ?? 'connection failed'}`)
        }
      }

      // 3b. Chat roundtrip → SSE emits working/thinking then idle.
      // Script the mock LLM to hold the stream open 800ms — long enough for
      // the SSE connection to establish before the agent finishes, avoiding
      // the race between connect and completion that would miss working events.
      if (sseReachable) {
        await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
        await fetch(`${mockLlmUrl}/mock/script`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pattern: 's33-sse-probe', response: 'swt-s33 probe response', delayMs: 800 })
        })

        // Start collecting SSE events before sending the message so we don't
        // miss the working event. collectSSEUntil starts the fetch immediately.
        const cycleEventsPromise = collectSSEUntil(
          sseUrl,
          (d) => (d as Record<string, unknown>).status === 'idle',
          15000
        )

        // 200ms for the SSE fetch to connect and start reading
        await new Promise<void>((r) => setTimeout(r, 200))

        await client.sendMessage(thread.id, 'swt-s33 s33-sse-probe roundtrip')
        const cycleEvents = await cycleEventsPromise

        metrics.cycleEventCount = cycleEvents.length
        metrics.cycleEvents = cycleEvents // full event list for diagnosis
        const sawWorking = (cycleEvents as Record<string, unknown>[]).some(
          (d) => d.status === 'working' || d.status === 'thinking'
        )
        const sawIdle = (cycleEvents as Record<string, unknown>[]).some((d) => d.status === 'idle')
        metrics.sawWorking = sawWorking
        metrics.sawIdle = sawIdle
        sseCycleOk = sawWorking && sawIdle

        if (!sseCycleOk) {
          failures.push(
            `SSE chat cycle: expected working+idle events, sawWorking=${sawWorking} sawIdle=${sawIdle} (${cycleEvents.length} total events)`
          )
        }
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err)
      failures.push(`SSE: ${msg}`)
      metrics.sseError = msg
    }

    // Cleanup
    if (thread) {
      try {
        await client.deleteThread(thread.id)
      } catch {
        /* ignore — best-effort cleanup */
      }
    }

    const passed = failures.length === 0
    const ad4mNote = ad4mMounted ? `cmd:400×2 no-client:${metrics.cmdNoClientStatus}` : 'cmd:skipped(no-ad4m)'
    return {
      passed,
      summary: passed
        ? `OK — slots:${slotsStatus} ${ad4mNote} sse-reachable:${sseReachable} sse-cycle:${sseCycleOk}`
        : `FAILED — ${failures.join('; ')}`,
      metrics,
      samples: client.samples
    }
  }
}
