// S26: Subagent Routing — the routing prompt and the tools a thread gets must
// agree.
//
// Since 6041e3e disabled `agents_spawn` (local-LLM subagents proved
// unreliable), the routing prompt tells the model to use Claude Code's
// built-in Task tool. So:
//   A. A local-llm thread's system prompt declares the routing policy, and its
//      tool list carries no `agents_spawn`.
//   B. A claude-code thread with the same routing gets that prompt AND keeps
//      the SDK's subagent tool. Stripping it (as the removed
//      makeSubagentToolBlocker did) left no subagent path at all.
//
// Self-skips when local-llm backend reports unavailable.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const skip = (summary: string): ScenarioResult => ({
  passed: true,
  summary,
  metrics: { skipped: true },
  samples: []
})

function is404(err: any): boolean {
  return String(err?.message ?? '').includes('→ 404')
}

/** The SDK names its subagent tool `Agent` (formerly `Task`). */
const SUBAGENT_TOOLS = ['Agent', 'Task']
const ROUTING = { subagentBackend: 'local-llm', subagentModel: 'test-model-s26' }

async function mockLog(mockLlmUrl: string): Promise<any[]> {
  return (await (await fetch(`${mockLlmUrl}/mock/log`)).json()) as any[]
}

export const s26SubagentRouting: Scenario = {
  id: 's26',
  name: 'Subagent Routing',
  description: 'Routing prompt and subagent tools agree on local-llm and claude-code threads',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}

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

    const threadIds: string[] = []
    const cleanup = async (result: ScenarioResult): Promise<ScenarioResult> => {
      client.disconnectWs()
      for (const id of threadIds) await client.deleteThread(id).catch(() => {})
      return result
    }
    const fail = (summary: string) => cleanup({ passed: false, summary, metrics, samples: client.samples })
    const createAndSend = async (label: string, extra: Record<string, unknown>): Promise<any> => {
      const created = await client.timed(`create-${label}`, () =>
        client.post('/api/threads', { label: `swt-s26-${label}`, ...ROUTING, ...extra })
      )
      const thread = created?.thread ?? created
      threadIds.push(thread.id)
      await client.timed(`send-${label}`, () => client.sendMessage(thread.id, 's26-routing-test hello'))
      await client.timed(`idle-${label}`, () => waitForThreadIdle(client, thread.id, 30000))
      return thread
    }

    await client.connectWs(['chat', 'threads'])

    // ── A. local-llm thread ──────────────────────────────────────────
    let local: any
    try {
      local = await createAndSend('local', { backend: 'local-llm' })
    } catch (err: any) {
      return fail(`local-llm thread setup failed: ${err?.message}`)
    }
    const localSystem = (await mockLog(mockLlmUrl))
      .filter((e) => e.format === 'openai')
      .flatMap((e) => (e.messages ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content ?? ''))
      .join('\n')
    const localRouting = /subagent routing/i.test(localSystem) && /local-llm/i.test(localSystem)
    metrics.localRouting = localRouting

    let localTools: string[] = []
    try {
      const budget = await client.timed('context-budget', () =>
        client.get(`/api/chat/context-budget?threadId=${encodeURIComponent(local.id)}`)
      )
      localTools = (budget?.tools?.entries ?? []).map((t: any) => t.name)
    } catch (err: any) {
      metrics.contextBudgetError = err?.message
    }
    const localSpawn = localTools.includes('sovereign_agents_spawn')
    metrics.localToolCount = localTools.length

    // ── B. claude-code thread, same routing ──────────────────────────
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    try {
      await createAndSend('cc', {})
    } catch (err: any) {
      return fail(`claude-code thread setup failed: ${err?.message}`)
    }
    // The main agent request carries the full tool list; side requests
    // (title generation) carry few or none.
    const main = (await mockLog(mockLlmUrl))
      .filter((e) => e.format === 'anthropic')
      .sort((a, b) => (b.tools?.length ?? 0) - (a.tools?.length ?? 0))[0]
    const ccTools: string[] = (main?.tools ?? []).map((t: any) => t.name)
    const ccSystem: string = main?.system ?? ''
    const ccRouting = /subagent routing/i.test(ccSystem) && /Task tool/.test(ccSystem)
    const subagentTool = SUBAGENT_TOOLS.find((t) => ccTools.includes(t))
    const ccSpawn = ccTools.some((t) => t.endsWith('agents_spawn'))
    metrics.ccToolCount = ccTools.length
    metrics.ccRouting = ccRouting
    metrics.subagentTool = subagentTool ?? null

    const passed = localRouting && !localSpawn && ccRouting && !!subagentTool && !ccSpawn
    return cleanup({
      passed,
      summary: passed
        ? `routing OK — local-llm prompt declares routing ✓, claude-code prompt names the Task tool and ` +
          `${subagentTool} is offered ✓ (${ccTools.length} tools), agents_spawn absent ✓`
        : `routing mismatch — local routing=${localRouting}, local agents_spawn=${localSpawn}, ` +
          `cc routing prompt=${ccRouting}, cc subagent tool=${subagentTool ?? 'MISSING'}, cc agents_spawn=${ccSpawn}`,
      metrics,
      samples: client.samples
    })
  }
}
