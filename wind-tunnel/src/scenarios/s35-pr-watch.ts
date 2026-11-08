// S35: PR watch tools — a claude-code thread is offered pr_watch /
// pr_watch_list / pr_unwatch (and no ci_* tools any more), and a pr_watch call
// reaches the server's watcher. The tunnel has no GitHub access, so the call
// uses a malformed repo: the watcher's own validation error coming back as the
// tool result proves the model → MCP → watcher path without a network call.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const TOOLS = ['mcp__sovereign__pr_watch', 'mcp__sovereign__pr_watch_list', 'mcp__sovereign__pr_unwatch']
const RETIRED = ['mcp__sovereign__ci_watch', 'mcp__sovereign__ci_watch_list', 'mcp__sovereign__ci_unwatch']
const TOOL_USE_ID = 'toolu_s35_pr_watch'

async function mockLog(mockLlmUrl: string): Promise<any[]> {
  return (await (await fetch(`${mockLlmUrl}/mock/log`)).json()) as any[]
}

/** The text of the tool_result for `toolUseId`, once the SDK echoes it back. */
async function toolResult(mockLlmUrl: string, toolUseId: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const entry of await mockLog(mockLlmUrl)) {
      for (const msg of entry?.messages ?? []) {
        if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue
        for (const block of msg.content) {
          if (block?.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue
          const c = block.content
          return typeof c === 'string' ? c : (c ?? []).map((b: any) => b?.text ?? '').join('\n')
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

export const s35PrWatch: Scenario = {
  id: 's35',
  name: 'PR Watch Tools',
  description: 'claude-code threads get the pr_watch tools (no ci_* tools) and a pr_watch call reaches the watcher',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    const created = await client.timed('create-thread', () =>
      client.post('/api/threads', { label: 'swt-s35-pr-watch' })
    )
    const thread = created?.thread ?? created
    const finish = async (result: ScenarioResult) => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }
    await client.connectWs(['chat'])

    // The SDK's first request for a new session may carry no tools.
    await client.timed('warmup-send', () => client.sendMessage(thread.id, 'warmup — initialise session'))
    await client.timed('warmup-idle', () => waitForThreadIdle(client, thread.id, 20000))
    const offered: string[] = (await mockLog(mockLlmUrl))
      .filter((e) => e.format === 'anthropic')
      .flatMap((e) => (e.tools ?? []).map((t: any) => t.name))
    const missing = TOOLS.filter((t) => !offered.includes(t))
    const retired = RETIRED.filter((t) => offered.includes(t))
    metrics.missingTools = missing
    metrics.retiredToolsOffered = retired

    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's35-pr-watch',
        once: true,
        needsTools: true,
        toolUse: {
          id: TOOL_USE_ID,
          name: TOOLS[0],
          input: { repo: 'not a repo', pr: 1, events: ['ci', 'comments', 'reviews'] }
        }
      })
    })
    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    await client.timed('send', () => client.sendMessage(thread.id, 'Please watch the PR for s35-pr-watch'))
    const result = await client.timed('tool-result', () => toolResult(mockLlmUrl, TOOL_USE_ID, 30000))
    await waitForThreadIdle(client, thread.id, 20000).catch(() => false)
    metrics.toolResult = result?.slice(0, 200) ?? null
    const reached = !!result && result.includes('repo must be "owner/name"')

    const passed = missing.length === 0 && retired.length === 0 && reached
    return finish({
      passed,
      summary: passed
        ? 'pr_watch, pr_watch_list, pr_unwatch offered, no ci_* tools; pr_watch call reached the watcher (validation error returned)'
        : `pr watch tools — missing: ${missing.join(', ') || 'none'}; retired still offered: ${retired.join(', ') || 'none'}; tool result: ${result?.slice(0, 120) ?? 'none'}`,
      metrics,
      samples: client.samples
    })
  }
}
