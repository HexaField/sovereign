// S16: Auto-Recycle — verify that Layer 2 context management recycles a
// session that crossed the threshold WITHOUT cutting a turn short.
//
// The wind tunnel config sets thresholdPercent=1 and minIntervalMs=0, and the
// thread gets contextWindow=50, so the first turn's usage (~10 tokens) crosses
// the threshold. The recycle must then run before the NEXT message, never in
// the middle of a turn: the second message must get a complete assistant reply
// promptly, with no chat.error, and lastRecycleAt must advance while it is sent.
// Phase A reproduces the live race: a message sent on idle reaches the backend
// before turn 1's result, and the old post-result recycle interrupted it.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

export const s16AutoRecycle: Scenario = {
  id: 's16',
  name: 'Auto-Recycle',
  description: 'Context threshold triggers automatic recycle after turn completion',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Clear mock state
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // 2. Create a thread with a tiny context window so the mock's
    //    input_tokens=10 exceeds the 1% threshold (10/50 = 20%).
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', {
          label: 'swt-s16-auto-recycle',
          // Bind the backend at creation so the window reaches the session on
          // every Sovereign version (the regression control runs the parent).
          backend: 'claude-code',
          contextWindow: 50
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

    // 3. Connect WS
    await client.connectWs(['chat', 'threads'])

    const finish = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // 4. First turn: crosses the recycle threshold.
    await client.timed('send-msg', () => client.sendMessage(thread.id, 's16-auto-recycle test message'))
    const idle = await client.timed('wait-idle', () => waitForThreadIdle(client, thread.id, 20000))
    metrics.firstTurnIdle = idle
    if (!idle) {
      return finish({ passed: false, summary: 'first turn never went idle', metrics, samples: client.samples })
    }

    const recycledAt = async (): Promise<number | null> => {
      const info = await client.get(`/api/threads/${thread.id}/session-info`)
      return info?.lastRecycleAt ?? null
    }
    const assistantTurn = (ms: number) =>
      client
        .waitForWs('chat.turn', ms, (d) => d.threadId === thread.id && d.turn?.role === 'assistant')
        .catch(() => null)
    const textOf = (t: any) =>
      typeof t?.turn?.content === 'string' ? t.turn.content : JSON.stringify(t?.turn?.content ?? '')

    // 5. Phase A — the live race. Claude Code announces idle just before its
    //    final assistant turn and result, so a message sent on idle reaches
    //    the backend while turn 1 is still finishing. The recycle that turn 1's
    //    result makes due must not interrupt turn 2.
    // A live turn with tool calls runs for minutes; the mock replies in ~100 ms,
    // which would finish before a recycle could interrupt it. Hold turn 2 open.
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's16 message sent on idle',
        response: 's16 racing reply',
        delayMs: 4000,
        once: true
      })
    })
    client.drainWs('chat.error')
    await client.timed('race-send', () => client.sendMessage(thread.id, 's16 message sent on idle'))
    const raceReply = await client.timed('race-turn', () =>
      client
        .waitForWs(
          'chat.turn',
          30000,
          (d) => d.threadId === thread.id && d.turn?.role === 'assistant' && textOf(d).includes('s16 racing reply')
        )
        .catch(() => null)
    )
    const raceErrors = client.drainWs('chat.error', (d) => d.threadId === thread.id)
    metrics.raceReply = textOf(raceReply).slice(0, 80)
    metrics.raceErrors = raceErrors.map((e) => e.error)
    const raceOk = raceReply != null && textOf(raceReply).length > 0 && raceErrors.length === 0

    // 6. Phase B — a settled session. Let turn 2's result land (it re-arms
    //    the due recycle), then the next message must run the recycle first.
    await new Promise((r) => setTimeout(r, 1500))
    const before = await recycledAt()
    metrics.lastRecycleAtBeforeThird = before
    client.drainWs('chat.status')
    client.drainWs('chat.turn')
    client.drainWs('chat.error')
    const sentAt = Date.now()
    await client.timed('post-recycle-send', () => client.sendMessage(thread.id, 'post-recycle s16 verification'))
    const reply = await client.timed('post-recycle-turn', () => assistantTurn(30000))
    const replyMs = Date.now() - sentAt
    const errors = client.drainWs('chat.error', (d) => d.threadId === thread.id)
    const after = await recycledAt()
    metrics.lastRecycleAtAfterThird = after
    metrics.replyMs = replyMs
    metrics.errors = errors.map((e) => e.error)

    // 7. Context-health reports the recycle count.
    let healthRecycleCount = 0
    try {
      const health = await client.timed('context-health', () => client.get(`/api/threads/${thread.id}/context-health`))
      healthRecycleCount = health?.layer2?.recycleCount ?? 0
    } catch {
      // Endpoint might not exist — degrade gracefully.
    }
    metrics.recycleCount = healthRecycleCount

    // 8. Assertions: the racing turn survived, the recycle ran before the
    //    third message, and that message's turn completed promptly and cleanly.
    const recycledBeforeThird = after != null && after >= sentAt && after > (before ?? 0)
    const replied = reply != null && textOf(reply).length > 0
    const prompt = replyMs < 8000
    const passed = raceOk && recycledBeforeThird && replied && prompt && errors.length === 0

    return finish({
      passed,
      summary: passed
        ? `auto-recycle OK — racing turn intact, recycled before the next message, reply in ${replyMs} ms, recycleCount=${healthRecycleCount}`
        : `auto-recycle failed — raceOk=${raceOk}, recycledBeforeThird=${recycledBeforeThird}, replied=${replied}, replyMs=${replyMs}, errors=${errors.length}`,
      metrics,
      samples: client.samples
    })
  }
}
