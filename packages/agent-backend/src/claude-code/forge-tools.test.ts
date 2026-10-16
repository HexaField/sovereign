import { describe, expect, it, vi } from 'vitest'
import { FORGE_TOOLS } from '@sovereign/core'
import type { ForgeMcpDeps } from './forge-tools.js'
import { createSovereignMcpServer, type SovereignToolDeps } from './mcp-server.js'

const RETHINK = 'rethink-thread'

function deps(thread: string, forge?: ForgeMcpDeps): SovereignToolDeps {
  const none = vi.fn()
  return {
    cron: { createUserMessageCron: none, list: none, remove: none },
    sessions: { list: none, send: none, history: none },
    agents: { list: none, spawn: none, stop: none },
    notifications: { send: none },
    planning: { createIssue: none, updateIssue: none },
    orgs: { list: () => [] },
    meetings: { list: none, read: none },
    browser: { open: none, act: none, close: none },
    currentSessionKey: () => thread,
    ...(forge ? { forge } : {})
  } as unknown as SovereignToolDeps
}

function tools(d: SovereignToolDeps): Record<string, { handler?: Function; callback?: Function }> {
  const cfg = createSovereignMcpServer(d) as any
  return cfg.instance?._registeredTools ?? {}
}

describe('forge rethink MCP tools', () => {
  const forge = (): ForgeMcpDeps & { call: ReturnType<typeof vi.fn> } => ({
    membraneOf: (id) => (id === RETHINK ? 'acme' : undefined),
    call: vi.fn(async (_t: string, name: string) =>
      name === 'forge_dispatch' ? { refused: 'job limit: 6 dispatches per run' } : { ok: true }
    )
  })

  it('are registered only in a forge-rethink thread, and only once bound', () => {
    expect(Object.keys(tools(deps(RETHINK, forge())))).toEqual(expect.arrayContaining([...FORGE_TOOLS]))
    expect(Object.keys(tools(deps(`agent:main:thread:${RETHINK}`, forge())))).toContain('forge_note')
    for (const absent of FORGE_TOOLS) {
      expect(Object.keys(tools(deps('other-thread', forge())))).not.toContain(absent)
      expect(Object.keys(tools(deps(RETHINK, {})))).not.toContain(absent)
      expect(Object.keys(tools(deps(RETHINK)))).not.toContain(absent)
    }
  })

  it('stay out of the subagent tool set', () => {
    const cfg = createSovereignMcpServer(deps(RETHINK, forge()), { include: ['browser_open'] }) as any
    expect(Object.keys(cfg.instance._registeredTools)).toEqual(['browser_open'])
  })

  it('pass the calling thread and arguments to the runner and return its answer', async () => {
    const f = forge()
    const t = tools(deps(RETHINK, f))
    const run = (name: string, args: Record<string, unknown>) => (t[name].handler ?? t[name].callback)!(args, {})
    const args = { membrane: 'acme', from: 'a', to: 'b', reason: 'same bug', confidence: 0.8 }
    const res = await run('forge_relate', args)
    expect(f.call).toHaveBeenCalledWith(RETHINK, 'forge_relate', args)
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: true })
    const refused = await run('forge_dispatch', { membrane: 'acme', nodeId: 'a', prompt: 'rebase' })
    expect(JSON.parse(refused.content[0].text)).toEqual({ refused: 'job limit: 6 dispatches per run' })
  })
})
