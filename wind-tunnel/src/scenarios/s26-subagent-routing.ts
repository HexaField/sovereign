// S26: Subagent Routing Enforcement — verify that a local-llm thread's
// subagent spawn routes through Sovereign's agents_spawn (not the SDK's
// native Agent tool) and that the system prompt injection declares the
// routing policy.
//
// Tests three aspects:
//   1. System prompt injection — the mock log's system messages must
//      contain the "Subagent Routing" section with the thread's
//      configured backend and model.
//   2. Tool schema filtering — the context budget must NOT include
//      Agent/Workflow/SendMessage tools (blocked by makeSubagentToolBlocker).
//   3. Sovereign tool presence — sovereign_agents_spawn must appear in
//      the registered tool schemas.
//
// Self-skips when local-llm backend reports unavailable.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

function is404(err: any): boolean {
  return String(err?.message ?? '').includes('→ 404')
}

export const s26SubagentRouting: Scenario = {
  id: 's26',
  name: 'Subagent Routing Enforcement',
  description: 'System prompt declares routing, SDK tools blocked, sovereign_agents_spawn available',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

    // 0. Check local-llm backend exists
    let backends: any[]
    try {
      const res = await client.get('/api/backends')
      backends = res?.backends ?? []
    } catch (err: any) {
      if (is404(err)) return skip('skipped — /api/backends not available')
      throw err
    }
    if (!backends.some((b: any) => b.kind === 'local-llm')) {
      return skip('skipped — local-llm backend not enabled')
    }

    // 1. Clear mock state
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await fetch(`${mockLlmUrl}/mock/scripts`, { method: 'DELETE' })

    // 2. Create a local-llm thread with explicit subagent routing config
    let thread: any
    try {
      thread = await client.timed('create-thread', () =>
        client.post('/api/threads', {
          label: 'swt-s26-routing',
          backend: 'local-llm',
          subagentBackend: 'local-llm',
          subagentModel: 'test-model-s26'
        })
      )
      thread = thread?.thread ?? thread
    } catch (err: any) {
      return { passed: false, summary: `thread creation failed: ${err?.message}`, metrics, samples: client.samples }
    }
    metrics.threadId = thread.id

    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }

    // 3. Send a message to trigger system prompt injection into the mock.
    //    The first request to the mock carries the full system prompt.
    await client.connectWs(['chat', 'threads'])

    try {
      await client.timed('send-message', () => client.sendMessage(thread.id, 's26-routing-test hello'))
    } catch (err: any) {
      return cleanup({
        passed: false,
        summary: `send failed: ${err?.message}`,
        metrics,
        samples: client.samples
      })
    }

    // Wait for idle
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try {
        const msg = await client.waitForWs('chat.status', Math.max(1, deadline - Date.now()))
        if (msg?.status === 'idle') break
      } catch {
        break
      }
    }

    // 4. Check mock log for system prompt content
    let mockLog: any[] = []
    try {
      const logRes = await fetch(`${mockLlmUrl}/mock/log`)
      mockLog = (await logRes.json()) as any[]
    } catch {
      metrics.mockLogError = 'failed to fetch'
    }

    const openAiRequests = mockLog.filter((e: any) => e.format === 'openai')
    metrics.openAiRequests = openAiRequests.length

    // Extract system prompt text from the first OpenAI request
    let systemPromptText = ''
    for (const req of openAiRequests) {
      const systemMsgs = (req.messages ?? []).filter((m: any) => m.role === 'system')
      for (const sm of systemMsgs) {
        systemPromptText += (sm.content ?? '') + '\n'
      }
      if (systemPromptText.length > 0) break
    }
    metrics.systemPromptLength = systemPromptText.length

    // Check for subagent routing declaration in the system prompt
    const hasRoutingSection = /subagent routing/i.test(systemPromptText)
    const mentionsLocalLlm = /local-llm/i.test(systemPromptText)
    const mentionsEnforcement = /enforc|programmatic/i.test(systemPromptText)
    metrics.hasRoutingSection = hasRoutingSection
    metrics.mentionsLocalLlm = mentionsLocalLlm
    metrics.mentionsEnforcement = mentionsEnforcement

    // 5. Check context budget for tool schema filtering
    let contextBudget: any = null
    try {
      contextBudget = await client.timed('context-budget', () =>
        client.get(`/api/chat/context-budget?threadId=${encodeURIComponent(thread.id)}`)
      )
    } catch (err: any) {
      metrics.contextBudgetError = err?.message
    }

    let toolNames: string[] = []
    if (contextBudget?.tools?.entries) {
      toolNames = contextBudget.tools.entries.map((t: any) => t.name)
    }
    metrics.totalTools = toolNames.length
    metrics.toolNames = toolNames

    // SDK tools that MUST be blocked for non-claude-code backends
    const blockedTools = ['Agent', 'Workflow', 'SendMessage']
    const leakedTools = blockedTools.filter((t) => toolNames.includes(t))
    metrics.leakedBlockedTools = leakedTools

    // sovereign_agents_spawn MUST be present (the approved spawn path)
    const hasAgentsSpawn = toolNames.includes('sovereign_agents_spawn')
    metrics.hasAgentsSpawn = hasAgentsSpawn

    // 6. Verdict
    const noLeakedTools = leakedTools.length === 0
    const routingDeclared = hasRoutingSection && mentionsLocalLlm
    const passed = routingDeclared && noLeakedTools && hasAgentsSpawn

    return cleanup({
      passed,
      summary: passed
        ? `routing enforcement OK — prompt declares routing: ✓, blocked tools absent: ✓ (${toolNames.length} tools), ` +
          `agents_spawn present: ✓`
        : `routing enforcement failed — routing-in-prompt=${routingDeclared}, ` +
          `leaked=${JSON.stringify(leakedTools)}, agents_spawn=${hasAgentsSpawn}`,
      metrics,
      samples: client.samples
    })
  }
}
