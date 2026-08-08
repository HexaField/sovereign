// S9: Session Resume — verify that active backend sessions survive a
// container restart via active-sessions.json and the resume orchestrator.
//
// This scenario exercises the shutdown → flush → freeze → restart → resume
// path. The mock LLM holds the SSE stream open (delayMs) so the session
// stays in 'working' state during the restart window.
//
// Proves: fix for the post-flush markIdle overwrite bug where
// disconnectAll's async teardown called remove() after flush(), erasing
// entries from disk before the exit timer fired.

import { execSync } from 'node:child_process'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForHealth(url: string, timeoutMs = 60000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error(`${url} failed to respond within ${timeoutMs}ms`)
}

export const s9SessionResume: Scenario = {
  id: 's9',
  name: 'Session Resume',
  description: 'Active sessions survive restart via freeze + resume orchestrator',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl, sovereignUrl, composeFile } = ctx
    const metrics: Record<string, unknown> = {}

    if (!composeFile) {
      return {
        passed: false,
        summary: 'skipped — requires Docker mode (no --native)',
        metrics,
        samples: client.samples
      }
    }

    // 1. Script a delayed mock response — hold the SSE stream open 8s
    //    so the session stays "working" during the restart.
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's9-resume-probe',
        response: 'Resume test response from mock LLM.',
        delayMs: 8000
      })
    })

    // 2. Create a test thread
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s9-resume' }))
    metrics.threadId = thread.id

    // 3. Fire a message (don't await — the mock holds the stream open 8s)
    const sendDone = client.sendMessage(thread.id, 'Hello s9-resume-probe test').catch(() => {
      // Expected: the connection drops when the container restarts
    })

    // 4. Wait for the session to become active (mock delay starts server-side)
    await sleep(2000)

    // 5. Read active-sessions.json from inside the container BEFORE restart
    let preRestartEntries = 0
    try {
      const asJson = execSync(
        `docker compose -f "${composeFile}" exec -T sovereign cat /data/data/agent-backend/active-sessions.json 2>/dev/null || echo '{"data":{}}'`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim()
      const parsed = JSON.parse(asJson)
      const data = parsed?.data ?? parsed ?? {}
      preRestartEntries = Object.keys(data).length
      metrics.preRestartEntries = preRestartEntries
      metrics.preRestartKeys = Object.keys(data)
    } catch (err: any) {
      metrics.preRestartError = err?.message
    }

    // 6. Restart the sovereign container (sends SIGTERM → shutdown handler)
    try {
      execSync(`docker compose -f "${composeFile}" restart sovereign`, { encoding: 'utf-8', timeout: 30000 })
    } catch (err: any) {
      return {
        passed: false,
        summary: `docker restart failed: ${err?.message}`,
        metrics,
        samples: client.samples
      }
    }

    // 7. Wait for sovereign to come back healthy
    await waitForHealth(sovereignUrl, 60000)
    // Give the resume orchestrator time to run
    await sleep(3000)

    // 8. Read active-sessions.json AFTER restart (before resume clears them)
    let postRestartEntries = 0
    try {
      const asJson = execSync(
        `docker compose -f "${composeFile}" exec -T sovereign cat /data/data/agent-backend/active-sessions.json 2>/dev/null || echo '{"data":{}}'`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim()
      const parsed = JSON.parse(asJson)
      const data = parsed?.data ?? parsed ?? {}
      postRestartEntries = Object.keys(data).length
      metrics.postRestartEntries = postRestartEntries
    } catch (err: any) {
      metrics.postRestartError = err?.message
    }

    // 9. Check resume summary from the dashboard endpoint
    let resumeSummary: any = null
    try {
      // Need a fresh client since the old connection broke
      const freshRes = await fetch(`${sovereignUrl}/api/dashboard/resume-summary`)
      resumeSummary = await freshRes.json()
      metrics.resumeSummary = resumeSummary
    } catch (err: any) {
      metrics.resumeSummaryError = err?.message
    }

    const totalResumed = resumeSummary?.total ?? 0
    metrics.totalResumed = totalResumed

    // 10. Also verify the thread still exists after restart
    let threadSurvived = false
    try {
      const freshRes = await fetch(`${sovereignUrl}/api/threads/${thread.id}`)
      const threadData = await freshRes.json()
      threadSurvived = (threadData?.thread?.id ?? threadData?.id) === thread.id
    } catch {
      /* lost */
    }
    metrics.threadSurvived = threadSurvived

    // Clean up the delayed send promise
    await sendDone

    // Cleanup: delete the test thread
    try {
      await fetch(`${sovereignUrl}/api/threads/${thread.id}`, { method: 'DELETE' })
    } catch {
      /* ignore */
    }

    // Verdict: the session entry should have survived the restart
    // (pre-restart entries > 0) and the resume orchestrator should
    // have picked it up (total > 0).
    const passed = preRestartEntries > 0 && totalResumed > 0

    return {
      passed,
      summary: passed
        ? `session survived restart — ${preRestartEntries} entry(ies) pre-restart, ${totalResumed} resumed`
        : `session lost on restart — ${preRestartEntries} pre-restart entries, ${totalResumed} resumed (expected >0 for both)`,
      metrics,
      samples: client.samples
    }
  }
}
