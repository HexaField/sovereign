import { describe, expect, it, vi } from 'vitest'
import { DECISION_TOOLS, type DecisionMcpDeps } from './decision-tools.js'
import { createSovereignMcpServer, type SovereignToolDeps } from './mcp-server.js'

const THREAD = 'thread-a'

function deps(session: string | undefined, decisions?: DecisionMcpDeps): SovereignToolDeps {
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
    currentSessionKey: () => session,
    ...(decisions ? { decisions } : {})
  } as unknown as SovereignToolDeps
}

function tools(d: SovereignToolDeps): Record<string, any> {
  return (createSovereignMcpServer(d) as any).instance?._registeredTools ?? {}
}

const bound = () => ({
  open: vi.fn(async (input: any) => ({ id: 'forge-decision://acme/1', membrane: input.membrane ?? 'acme', ...input })),
  close: vi.fn(async (id: string, resolution: string) => ({ id, status: 'resolved', resolution }) as any)
})

const call = (t: Record<string, any>, name: string, args: Record<string, unknown>) =>
  (t[name].handler ?? t[name].callback)(t[name].inputSchema.parse(args), {})

describe('decision MCP tools', () => {
  it('are registered in every thread once bound, and never for subagents', () => {
    expect(Object.keys(tools(deps(THREAD, bound())))).toEqual(expect.arrayContaining([...DECISION_TOOLS]))
    expect(Object.keys(tools(deps(`agent:main:thread:${THREAD}`, bound())))).toContain('decision_open')
    for (const name of DECISION_TOOLS) {
      expect(Object.keys(tools(deps(THREAD, {})))).not.toContain(name)
      expect(Object.keys(tools(deps(THREAD)))).not.toContain(name)
      expect(Object.keys(tools(deps(undefined, bound())))).not.toContain(name)
    }
    const sub = createSovereignMcpServer(deps(THREAD, bound()), { include: ['browser_open'] }) as any
    expect(Object.keys(sub.instance._registeredTools)).toEqual(['browser_open'])
  })

  it('decision_open defaults the thread to the caller, leaves the membrane to the server, and returns the decision', async () => {
    const d = bound()
    const t = tools(deps(`agent:main:thread:${THREAD}`, d))
    const res = await call(t, 'decision_open', { question: 'Which database?', options: ['SQLite', 'Postgres'] })
    expect(d.open).toHaveBeenCalledWith({
      question: 'Which database?',
      options: ['SQLite', 'Postgres'],
      threadId: THREAD,
      createdBy: THREAD
    })
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      id: 'forge-decision://acme/1',
      question: 'Which database?'
    })

    await call(t, 'decision_open', {
      question: 'Ship Friday?',
      context: 'Release train',
      source: { kind: 'plan', ref: 'plans/release.md', label: 'Release plan' },
      group: 'Release',
      threadId: 'thread-b',
      membrane: 'beta'
    })
    expect(d.open).toHaveBeenLastCalledWith({
      question: 'Ship Friday?',
      context: 'Release train',
      source: { kind: 'plan', ref: 'plans/release.md', label: 'Release plan' },
      group: 'Release',
      threadId: 'thread-b',
      membrane: 'beta',
      createdBy: THREAD
    })
  })

  it('validates input: a question, known source kinds, string options', () => {
    const schema = tools(deps(THREAD, bound())).decision_open.inputSchema
    expect(schema.safeParse({ question: 'q' }).success).toBe(true)
    expect(schema.safeParse({ question: '  ' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ question: 'q', source: { kind: 'chat', ref: 'x' } }).success).toBe(false)
    expect(schema.safeParse({ question: 'q', source: { kind: 'thread', ref: '' } }).success).toBe(false)
    expect(schema.safeParse({ question: 'q', options: [1] }).success).toBe(false)
    const close = tools(deps(THREAD, bound())).decision_close.inputSchema
    expect(close.safeParse({ id: 'forge-decision://acme/1', resolution: 'Yes' }).success).toBe(true)
    expect(close.safeParse({ id: 'forge-decision://acme/1', resolution: '' }).success).toBe(false)
    expect(close.safeParse({ resolution: 'Yes' }).success).toBe(false)
  })

  it('decision_close records the resolution through the server', async () => {
    const d = bound()
    const res = await call(tools(deps(THREAD, d)), 'decision_close', {
      id: 'forge-decision://acme/1',
      resolution: 'Settled in review'
    })
    expect(d.close).toHaveBeenCalledWith('forge-decision://acme/1', 'Settled in review')
    expect(JSON.parse(res.content[0].text)).toMatchObject({ status: 'resolved' })
  })

  it('tell agents to use it instead of asking in chat, and to group related questions', () => {
    const t = tools(deps(THREAD, bound()))
    expect(t.decision_open.description).toMatch(/INSTEAD of asking the user a question in chat/)
    expect(t.decision_open.description).toMatch(/can wait/)
    expect(t.decision_open.description).toMatch(/same `group` name on related questions/)
    expect(t.decision_close.description).toMatch(/Sends no message/)
  })
})
