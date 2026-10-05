// S36: edits go through the edit tools, not the shell. A claude-code thread
// is offered mcp__code__edit and mcp__code__edit_files; the CLI's bash-first
// steer ("make file changes with sed, heredocs, or short scripts") never
// reaches the model, although the container forces it on (docker-compose
// sets CLAUDE_CODE_THRIFTY_SONIC=1 and Sovereign overrides it per session);
// and a Bash `sed -i` call is denied with a pointer to the edit tools.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const TOOLS = ['mcp__code__edit', 'mcp__code__edit_files']
const STEER = 'While bypass permissions mode is active'
const TOOL_USE_ID = 'toolu_s36_sed'

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

export const s36EditToolsOverScripts: Scenario = {
  id: 's36',
  name: 'Edit Tools Over Scripts',
  description: 'edit tools offered, the bash-first steer suppressed, and sed -i denied',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    const created = await client.timed('create-thread', () =>
      client.post('/api/threads', { label: 'swt-s36-edit-tools' })
    )
    const thread = created?.thread ?? created
    const finish = async (result: ScenarioResult) => {
      client.disconnectWs()
      await client.deleteThread(thread.id).catch(() => {})
      return result
    }
    await client.connectWs(['chat'])

    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    // The SDK's first request for a new session may carry no tools.
    await client.timed('warmup-send', () => client.sendMessage(thread.id, 'warmup — initialise session'))
    await client.timed('warmup-idle', () => waitForThreadIdle(client, thread.id, 20000))
    const log = (await mockLog(mockLlmUrl)).filter((e) => e.format === 'anthropic')
    const offered: string[] = log.flatMap((e) => (e.tools ?? []).map((t: any) => t.name))
    const missing = TOOLS.filter((t) => !offered.includes(t))
    const steered = log.some((e) => JSON.stringify(e.messages ?? []).includes(STEER))
    metrics.requests = log.length
    metrics.missingTools = missing
    metrics.steerSeen = steered

    await fetch(`${mockLlmUrl}/mock/script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 's36-sed-edit',
        once: true,
        needsTools: true,
        toolUse: { id: TOOL_USE_ID, name: 'Bash', input: { command: "sed -i 's/a/b/' notes.md" } }
      })
    })
    await client.timed('send', () => client.sendMessage(thread.id, 'Please make the s36-sed-edit change'))
    const result = await client.timed('tool-result', () => toolResult(mockLlmUrl, TOOL_USE_ID, 30000))
    await waitForThreadIdle(client, thread.id, 20000).catch(() => false)
    metrics.toolResult = result?.slice(0, 200) ?? null
    const denied = !!result && result.includes('Sovereign blocks file edits through the shell')

    const passed = log.length > 0 && missing.length === 0 && !steered && denied
    return finish({
      passed,
      summary: passed
        ? 'edit + edit_files offered; bash-first steer absent despite the forced flag; sed -i denied'
        : `missing tools: ${missing.join(', ') || 'none'}; steer seen: ${steered}; sed result: ${result?.slice(0, 120) ?? 'none'}`,
      metrics,
      samples: client.samples
    })
  }
}
