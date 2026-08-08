// S1: Cold Start — verify the server boots, health responds, and
// core subsystems initialise.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s1ColdStart: Scenario = {
  id: 's1',
  name: 'Cold Start',
  description: 'Server boots, health endpoint responds, core modules initialise',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Health check
    const health = await client.timed('health', () => client.health())
    if (health.status !== 'ok') {
      return { passed: false, summary: `health returned ${health.status}`, metrics, samples: client.samples }
    }
    metrics.healthStatus = health.status

    // 2. System health (module-level detail)
    const sysHealth = await client.timed('system-health', () => client.systemHealth())
    metrics.systemHealth = sysHealth

    // 3. Config loads
    const config = await client.timed('config', () => client.config())
    metrics.hasConfig = config != null

    // 4. WS connects and subscribes
    await client.timed('ws-connect', () => client.connectWs(['chat', 'threads']))
    metrics.wsConnected = true

    // 5. Thread list works (may have presence threads auto-created)
    const threads = await client.timed('list-threads', () => client.listThreads())
    metrics.threadCount = threads.length

    // 6. Chat status
    const chatStatus = await client.timed('chat-status', () => client.chatStatus())
    metrics.chatStatus = chatStatus

    client.disconnectWs()

    return {
      passed: true,
      summary: `boot OK — ${threads.length} threads, WS connected`,
      metrics,
      samples: client.samples
    }
  }
}
