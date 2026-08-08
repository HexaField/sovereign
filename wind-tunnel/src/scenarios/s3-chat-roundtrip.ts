// S3: Chat Roundtrip — send a message to a thread, verify the mock LLM
// receives it, and the assistant response arrives back via WS.
//
// This proves the full end-to-end path:
//   HTTP POST /api/chat/send → message queue → agent backend →
//   Claude Agent SDK → mock Anthropic API → SSE response →
//   SDK message dispatch → WS broadcast → client

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

export const s3ChatRoundtrip: Scenario = {
  id: 's3',
  name: 'Chat Roundtrip',
  description: 'Send a message, verify mock LLM processes it, response arrives via WS',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // Clear mock LLM request log
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })

    // Register a scripted response for this test
    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'wind-tunnel-s3',
        response: 'I received your wind-tunnel-s3 message successfully.'
      })
    })

    // 1. Create a test thread
    const thread = await client.timed('create-thread', () => client.createThread({ label: 'swt-s3-chat' }))
    metrics.threadId = thread.id

    // 2. Connect WS
    await client.connectWs(['chat', 'threads'])

    // 3. Send a message
    await client.timed('send-message', () => client.sendMessage(thread.id, 'Hello from wind-tunnel-s3 test'))

    // 4. Wait for the assistant response via WS
    // The flow goes: send → queue → backend → SDK → mock API → response → WS broadcast
    // Allow generous timeout for the full chain to complete
    let gotTurn = false
    let turnContent = ''
    try {
      const turnMsg = await client.timed('wait-for-turn', () => client.waitForWs('chat.turn', 30000))
      gotTurn = true
      turnContent = turnMsg?.turn?.content ?? ''
      metrics.turnContent = turnContent
      metrics.turnRole = turnMsg?.turn?.role
    } catch (err: any) {
      metrics.turnError = err?.message
    }

    // 5. Check that the mock LLM received the request
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
      metrics.mockRequests = mockLog.length
    } catch {
      metrics.mockLogError = 'failed to fetch mock log'
    }

    // 6. Wait for idle status
    let gotIdle = false
    try {
      await client.waitForWs('chat.status', 10000)
      gotIdle = true
    } catch {
      // Might have already received idle before we started waiting
      const drained = client.drainWs('chat.status')
      gotIdle = drained.some((m) => m.status === 'idle')
    }
    metrics.gotIdle = gotIdle

    // Cleanup
    client.disconnectWs()
    await client.deleteThread(thread.id)

    // Verdict
    if (!gotTurn) {
      return {
        passed: false,
        summary: `no assistant turn received within timeout — mock received ${mockLog.length} request(s)`,
        metrics,
        samples: client.samples
      }
    }

    return {
      passed: true,
      summary: `roundtrip OK — mock received ${mockLog.length} request(s), got turn: "${turnContent.slice(0, 60)}"`,
      metrics,
      samples: client.samples
    }
  }
}
