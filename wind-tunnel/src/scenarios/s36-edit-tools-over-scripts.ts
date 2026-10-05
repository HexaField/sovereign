// S36: edits go through the edit tools, not the shell. A claude-code thread
// is offered mcp__code__edit and mcp__code__edit_files, and the CLI's
// bash-first steer ("make file changes with sed, heredocs, or short scripts")
// never reaches the model, although the container forces it on
// (docker-compose sets CLAUDE_CODE_THRIFTY_SONIC=1 and Sovereign overrides it
// per session).

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
import { waitForThreadIdle } from '../wait.js'

const TOOLS = ['mcp__code__edit', 'mcp__code__edit_files']
const STEER = 'While bypass permissions mode is active'

export const s36EditToolsOverScripts: Scenario = {
  id: 's36',
  name: 'Edit Tools Over Scripts',
  description: 'edit tools offered and the bash-first steer suppressed',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl } = ctx
    const metrics: Record<string, unknown> = {}
    const created = await client.timed('create-thread', () =>
      client.post('/api/threads', { label: 'swt-s36-edit-tools' })
    )
    const thread = created?.thread ?? created
    await client.connectWs(['chat'])

    await fetch(`${mockLlmUrl}/mock/log`, { method: 'DELETE' })
    // The SDK's first request for a new session may carry no tools.
    await client.timed('warmup-send', () => client.sendMessage(thread.id, 'warmup — initialise session'))
    await client.timed('warmup-idle', () => waitForThreadIdle(client, thread.id, 20000))
    await client.timed('send', () => client.sendMessage(thread.id, 'second turn'))
    await client.timed('idle', () => waitForThreadIdle(client, thread.id, 20000))

    const log = ((await (await fetch(`${mockLlmUrl}/mock/log`)).json()) as any[]).filter(
      (e) => e.format === 'anthropic'
    )
    const offered: string[] = log.flatMap((e) => (e.tools ?? []).map((t: any) => t.name))
    const missing = TOOLS.filter((t) => !offered.includes(t))
    const steered = log.some((e) => JSON.stringify(e.messages ?? []).includes(STEER))
    metrics.requests = log.length
    metrics.missingTools = missing
    metrics.steerSeen = steered

    client.disconnectWs()
    await client.deleteThread(thread.id).catch(() => {})
    const passed = log.length > 0 && missing.length === 0 && !steered
    return {
      passed,
      summary: passed
        ? `edit + edit_files offered; bash-first steer absent in ${log.length} requests despite the forced flag`
        : `requests: ${log.length}; missing tools: ${missing.join(', ') || 'none'}; steer seen: ${steered}`,
      metrics,
      samples: client.samples
    }
  }
}
