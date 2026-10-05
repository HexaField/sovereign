// S41: the recycle gate. A session whose context stays over the threshold
// after a recycle (real conversation, nothing for pruning to free) used to
// recycle before every message. With the gate, the first recycle frees ~0 %,
// marks pruning exhausted, and no further recycle runs while the context
// stays full.
//
// The wind tunnel's base config sets regrowPercent/minReclaimPercent to 0 so
// s12/s16/s30 keep recycling freely; this scenario turns the gate on (the
// production defaults, 10 % / 5 %) and restores the base values afterwards.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const gate = (regrowPercent: number, minReclaimPercent: number) => ({
  contextManagement: { recycle: { regrowPercent, minReclaimPercent } }
})

export const s41RecycleGate: Scenario = {
  id: 's41',
  name: 'Recycle Gate',
  description: 'a session pruning cannot shrink recycles once, not before every message',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })
    await client.patch('/api/config', gate(10, 5))

    // A 50-token window: every mock turn (~10 tokens in) sits far past the 1 % threshold.
    const created = await client.post('/api/threads', {
      label: 'swt-s41-recycle-gate',
      backend: 'claude-code',
      contextWindow: 50
    })
    const thread = created?.thread ?? created
    const recycleAt = async (): Promise<number | null> =>
      (await client.get(`/api/threads/${thread.id}/session-info`))?.lastRecycleAt ?? null

    await client.connectWs(['chat', 'threads']) // idle detection rides on WS status events
    const recycles: number[] = []
    let turnsOk = 0
    try {
      for (let i = 1; i <= 5; i++) {
        const before = await recycleAt()
        await client.sendMessage(thread.id, `s41 gate turn ${i}`)
        if (await waitForThreadIdle(client, thread.id, 20_000)) turnsOk++
        await new Promise((r) => setTimeout(r, 500))
        const after = await recycleAt()
        if (after != null && after !== before) recycles.push(i)
      }
    } finally {
      client.disconnectWs()
      await client.patch('/api/config', gate(0, 0)).catch(() => {})
      await client.deleteThread(thread.id).catch(() => {})
    }

    metrics.recycledBeforeTurn = recycles
    metrics.turnsOk = turnsOk
    // Turn 1 crosses the threshold; the recycle runs before turn 2 and frees ~nothing.
    const passed = turnsOk === 5 && recycles.length === 1 && recycles[0] === 2
    return {
      passed,
      summary: passed
        ? '5 turns at a full context: one recycle (before turn 2), then none — pruning marked exhausted'
        : `turnsOk=${turnsOk}/5, recycled before turns ${JSON.stringify(recycles)} (want [2])`,
      metrics,
      samples: client.samples
    }
  }
}
