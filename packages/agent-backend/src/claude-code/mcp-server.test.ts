import { describe, it, expect, vi } from 'vitest'
import { createSovereignMcpServer, type SovereignToolDeps } from './mcp-server.js'

/**
 * Tests for the Sovereign MCP server wiring. We bypass the SDK transport
 * and invoke handlers directly via the McpServer instance's internal
 * registered-tools map.
 */

function makeDeps(overrides: Partial<SovereignToolDeps> = {}): SovereignToolDeps {
  return {
    cron: {
      createUserMessageCron: vi.fn().mockResolvedValue({ id: 'cron-1', schedule: 'cron(* * * * *)' }),
      list: vi.fn().mockResolvedValue([{ id: 'cron-1', sessionKey: 'agent:main:thread:t1' }]),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    sessions: {
      list: vi.fn().mockResolvedValue([{ key: 'agent:main:thread:t1', label: 't1', kind: 'thread' }]),
      send: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue([{ role: 'user', content: 'hi' }])
    },
    agents: {
      list: vi.fn().mockResolvedValue([{ sessionKey: 'sub-1', label: 'explore', status: 'idle' }]),
      spawn: vi.fn().mockResolvedValue({ sessionKey: 'agent:main:subagent:abc' })
    },
    notifications: { send: vi.fn().mockReturnValue({ id: 'n-1' }) },
    planning: {
      createIssue: vi.fn().mockResolvedValue({ id: 'i-1', orgId: 'o', projectId: 'p', title: 'T' }),
      updateIssue: vi.fn().mockResolvedValue({ id: 'i-1', orgId: 'o', projectId: 'p', title: 'T', state: 'closed' })
    },
    orgs: { list: vi.fn().mockReturnValue([{ id: '_global', name: 'Global', path: '/tmp' }]) },
    meetings: {
      list: vi.fn().mockResolvedValue([{ id: 'm-1', title: 'Standup', createdAt: '2026-01-01' }]),
      read: vi.fn().mockResolvedValue({ id: 'm-1', title: 'Standup', transcript: 'hello', summary: 'quick sync' })
    },
    browser: {
      open: vi.fn().mockResolvedValue({ sessionId: 'b-1', url: 'https://x', title: 'X', summary: 'Page loaded' }),
      act: vi.fn().mockResolvedValue({ message: 'clicked', url: 'https://x', title: 'X' }),
      close: vi.fn().mockResolvedValue(undefined)
    },
    currentSessionKey: () => 'agent:main:thread:t1',
    ...overrides
  }
}

/** Extract registered tool handlers from the MCP server instance. */
function getTools(deps: SovereignToolDeps): Record<string, { callback: Function }> {
  const cfg = createSovereignMcpServer(deps) as any
  return cfg.instance?._registeredTools ?? cfg.instance?.registeredTools ?? {}
}

function invoke(tools: Record<string, any>, name: string, args: Record<string, unknown> = {}) {
  const handler = tools[name]?.callback ?? tools[name]?.handler
  if (typeof handler !== 'function') {
    throw new Error(`handler "${name}" not found on MCP server instance`)
  }
  return handler(args, {})
}

/** Parse the JSON text from the first content block of a tool result. */
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text)
}

describe('claude-code/mcp-server', () => {
  it('creates an MCP server config with the expected name', () => {
    const cfg = createSovereignMcpServer(makeDeps())
    expect(cfg.type).toBe('sdk')
    expect(cfg.name).toBe('sovereign')
  })

  it('exposes all required tool names', () => {
    const cfg = createSovereignMcpServer(makeDeps()) as any
    const tools = cfg.instance?._registeredTools ?? cfg.instance?.registeredTools ?? cfg.instance?.tools
    expect(cfg.instance).toBeDefined()
    if (tools) {
      const names = Object.keys(tools)
      for (const expected of [
        'cron_create',
        'cron_list',
        'cron_delete',
        'sessions_list',
        'sessions_send',
        'sessions_history',
        'browser_open',
        'browser_act',
        'browser_close',
        'agents_spawn',
        'agents_list',
        'notifications_send',
        'create_issue',
        'update_planning_node',
        'list_orgs',
        'read_meeting'
      ]) {
        expect(names, `missing tool: ${expected}`).toContain(expected)
      }
    }
  })

  // ── cron ────────────────────────────────────────────────────────────────

  describe('cron_create', () => {
    it('uses the current thread when threadKey omitted', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-x', schedule: 'every 60s' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any,
        currentSessionKey: () => 'agent:main:thread:neural-nets'
      })
      const tools = getTools(deps)
      const result = await invoke(tools, 'cron_create', {
        when: { kind: 'interval', everyMs: 60000 },
        prompt: 'tick'
      })
      expect(createSpy).toHaveBeenCalledTimes(1)
      expect(createSpy.mock.calls[0][0].threadKey).toBe('neural-nets')
      const parsed = parseResult(result) as any
      expect(parsed.threadKey).toBe('neural-nets')
      expect(parsed.id).toBe('cron-x')
    })

    it('honours explicit threadKey to cross-post', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-y', schedule: 'once' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any
      })
      const tools = getTools(deps)
      await invoke(tools, 'cron_create', {
        threadKey: 'maps',
        when: { kind: 'oneshot', at: '2099-01-01T00:00:00Z' },
        prompt: 'cross-post'
      })
      expect(createSpy.mock.calls[0][0].threadKey).toBe('maps')
    })

    it('strips agent:main:main → main', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-z', schedule: 'once' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any,
        currentSessionKey: () => 'agent:main:main'
      })
      const tools = getTools(deps)
      await invoke(tools, 'cron_create', {
        when: { kind: 'interval', everyMs: 60000 },
        prompt: 'tick'
      })
      expect(createSpy.mock.calls[0][0].threadKey).toBe('main')
    })

    it('throws when no threadKey and no calling session', async () => {
      const deps = makeDeps({ currentSessionKey: () => undefined })
      const tools = getTools(deps)
      await expect(
        invoke(tools, 'cron_create', { when: { kind: 'interval', everyMs: 60000 }, prompt: 'tick' })
      ).rejects.toThrow(/threadKey is required/)
    })

    it('rejects kind=cron without expr', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await expect(invoke(tools, 'cron_create', { when: { kind: 'cron' }, prompt: 'tick' })).rejects.toThrow(
        /kind=cron requires expr/
      )
    })

    it('rejects kind=interval without everyMs', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await expect(invoke(tools, 'cron_create', { when: { kind: 'interval' }, prompt: 'tick' })).rejects.toThrow(
        /kind=interval requires everyMs/
      )
    })

    it('rejects kind=oneshot without at', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await expect(invoke(tools, 'cron_create', { when: { kind: 'oneshot' }, prompt: 'tick' })).rejects.toThrow(
        /kind=oneshot requires at/
      )
    })

    it('passes label through to the cron service', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-l', schedule: 'once' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any
      })
      const tools = getTools(deps)
      await invoke(tools, 'cron_create', {
        when: { kind: 'oneshot', at: '2099-01-01T00:00:00Z' },
        prompt: 'check',
        label: 'my-check'
      })
      expect(createSpy.mock.calls[0][0].label).toBe('my-check')
    })
  })

  describe('cron_list', () => {
    it('returns all crons when no threadKey filter', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'cron_list', {})
      const parsed = parseResult(result) as any
      expect(parsed.crons).toHaveLength(1)
      expect(deps.cron.list).toHaveBeenCalledWith(true)
    })

    it('filters by threadKey — exact match', async () => {
      const listSpy = vi.fn().mockResolvedValue([
        { id: 'c1', sessionTarget: 'neural-nets' },
        { id: 'c2', sessionTarget: 'experiments' }
      ])
      const deps = makeDeps({ cron: { createUserMessageCron: vi.fn(), list: listSpy, remove: vi.fn() } as any })
      const tools = getTools(deps)
      const result = await invoke(tools, 'cron_list', { threadKey: 'neural-nets' })
      const parsed = parseResult(result) as any
      expect(parsed.crons).toHaveLength(1)
      expect(parsed.crons[0].id).toBe('c1')
    })

    it('filters by threadKey — canonical suffix match', async () => {
      const listSpy = vi.fn().mockResolvedValue([
        { id: 'c1', sessionTarget: 'agent:main:thread:neural-nets' },
        { id: 'c2', sessionTarget: 'agent:main:thread:experiments' }
      ])
      const deps = makeDeps({ cron: { createUserMessageCron: vi.fn(), list: listSpy, remove: vi.fn() } as any })
      const tools = getTools(deps)
      const result = await invoke(tools, 'cron_list', { threadKey: 'neural-nets' })
      const parsed = parseResult(result) as any
      expect(parsed.crons).toHaveLength(1)
      expect(parsed.crons[0].id).toBe('c1')
    })
  })

  describe('cron_delete', () => {
    it('calls deps.cron.remove and confirms', async () => {
      const removeSpy = vi.fn().mockResolvedValue(undefined)
      const deps = makeDeps({ cron: { createUserMessageCron: vi.fn(), list: vi.fn(), remove: removeSpy } as any })
      const tools = getTools(deps)
      const result = await invoke(tools, 'cron_delete', { id: 'cron-42' })
      expect(removeSpy).toHaveBeenCalledWith('cron-42')
      expect(result.content[0].text).toContain('cron-42')
    })
  })

  // ── sessions ────────────────────────────────────────────────────────────

  describe('sessions_list', () => {
    it('returns sessions without filter', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'sessions_list', {})
      const parsed = parseResult(result) as any
      expect(parsed.sessions).toHaveLength(1)
      expect(parsed.sessions[0].key).toBe('agent:main:thread:t1')
      expect(deps.sessions.list).toHaveBeenCalledWith(undefined)
    })

    it('passes backendKind filter to deps', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'sessions_list', { backendKind: 'local-llm' })
      expect(deps.sessions.list).toHaveBeenCalledWith({ backendKind: 'local-llm' })
    })
  })

  describe('sessions_send', () => {
    it('calls deps.sessions.send and confirms delivery', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'sessions_send', { sessionKey: 'target-thread', text: 'hello there' })
      expect(deps.sessions.send).toHaveBeenCalledWith('target-thread', 'hello there')
      expect(result.content[0].text).toContain('target-thread')
    })
  })

  describe('sessions_history', () => {
    it('returns turns with default limit of 20', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'sessions_history', { sessionKey: 'some-thread' })
      expect(deps.sessions.history).toHaveBeenCalledWith('some-thread', 20)
      const parsed = parseResult(result) as any
      expect(parsed.turns).toHaveLength(1)
    })

    it('respects explicit limit', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'sessions_history', { sessionKey: 'some-thread', limit: 5 })
      expect(deps.sessions.history).toHaveBeenCalledWith('some-thread', 5)
    })
  })

  // ── browser ─────────────────────────────────────────────────────────────

  describe('browser_open', () => {
    it('calls deps.browser.open and returns sessionId + summary', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'browser_open', { url: 'https://example.com' })
      expect(deps.browser.open).toHaveBeenCalledWith({
        url: 'https://example.com',
        headed: undefined,
        viewport: undefined,
        sessionId: undefined
      })
      const parsed = parseResult(result) as any
      expect(parsed.sessionId).toBe('b-1')
      expect(parsed.summary).toBe('Page loaded')
    })

    it('passes viewport and headed options', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'browser_open', {
        url: 'https://example.com',
        headed: true,
        viewport: { width: 1280, height: 720 }
      })
      expect(deps.browser.open).toHaveBeenCalledWith({
        url: 'https://example.com',
        headed: true,
        viewport: { width: 1280, height: 720 },
        sessionId: undefined
      })
    })

    it('reuses an existing session when sessionId provided', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'browser_open', { url: 'https://example.com', sessionId: 'existing-session' })
      expect(deps.browser.open).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing-session' }))
    })
  })

  describe('browser_act', () => {
    it('calls deps.browser.act and returns text summary', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'browser_act', {
        sessionId: 'b-1',
        action: { kind: 'click', ref: 'r1' }
      })
      expect(deps.browser.act).toHaveBeenCalledWith('b-1', { kind: 'click', ref: 'r1' })
      const textBlock = result.content.find((c: any) => c.type === 'text')
      const parsed = JSON.parse(textBlock.text)
      expect(parsed.message).toBe('clicked')
    })

    it('returns image as separate content block when present', async () => {
      const deps = makeDeps({
        browser: {
          open: vi.fn().mockResolvedValue({ sessionId: 'b-1', url: 'x', title: 'X', summary: '' }),
          act: vi.fn().mockResolvedValue({
            message: 'screenshot taken',
            imageBase64: 'iVBORw0KGgo=',
            imageMime: 'image/png'
          }),
          close: vi.fn().mockResolvedValue(undefined)
        }
      })
      const tools = getTools(deps)
      const result = await invoke(tools, 'browser_act', {
        sessionId: 'b-1',
        action: { kind: 'screenshot' }
      })
      expect(result.content).toHaveLength(2)
      expect(result.content[0].type).toBe('text')
      expect(result.content[1].type).toBe('image')
      expect(result.content[1].data).toBe('iVBORw0KGgo=')
      expect(result.content[1].mimeType).toBe('image/png')
    })

    it('truncates long text responses at 4000 chars', async () => {
      const longText = 'x'.repeat(5000)
      const deps = makeDeps({
        browser: {
          open: vi.fn().mockResolvedValue({ sessionId: 'b-1', url: 'x', title: 'X', summary: '' }),
          act: vi.fn().mockResolvedValue({ message: 'extracted', text: longText }),
          close: vi.fn().mockResolvedValue(undefined)
        }
      })
      const tools = getTools(deps)
      const result = await invoke(tools, 'browser_act', {
        sessionId: 'b-1',
        action: { kind: 'extract' }
      })
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.text.length).toBeLessThan(5000)
      expect(parsed.text).toContain('…(truncated)')
    })

    it('omits image block when no image returned', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'browser_act', {
        sessionId: 'b-1',
        action: { kind: 'snapshot' }
      })
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
    })
  })

  describe('browser_close', () => {
    it('calls deps.browser.close and confirms', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'browser_close', { sessionId: 'b-1' })
      expect(deps.browser.close).toHaveBeenCalledWith('b-1')
      expect(result.content[0].text).toContain('b-1')
    })
  })

  // ── agents ──────────────────────────────────────────────────────────────

  describe('agents_spawn', () => {
    it('spawns a subagent using currentSessionKey as parent', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'agents_spawn', { task: 'explore codebase' })
      expect(deps.agents.spawn).toHaveBeenCalledWith('agent:main:thread:t1', {
        task: 'explore codebase',
        label: undefined,
        backend: undefined,
        model: undefined
      })
      const parsed = parseResult(result) as any
      expect(parsed.sessionKey).toBe('agent:main:subagent:abc')
      expect(parsed.parentSessionKey).toBe('agent:main:thread:t1')
    })

    it('uses explicit parentSessionKey over currentSessionKey', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'agents_spawn', {
        task: 'work',
        parentSessionKey: 'agent:main:thread:other'
      })
      expect(deps.agents.spawn).toHaveBeenCalledWith(
        'agent:main:thread:other',
        expect.objectContaining({ task: 'work' })
      )
    })

    it('passes backend and model options', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'agents_spawn', {
        task: 'research',
        backend: 'local-llm',
        model: 'qwen3-8b',
        label: 'researcher'
      })
      expect(deps.agents.spawn).toHaveBeenCalledWith('agent:main:thread:t1', {
        task: 'research',
        backend: 'local-llm',
        model: 'qwen3-8b',
        label: 'researcher'
      })
    })

    it('throws when no parent available', async () => {
      const deps = makeDeps({ currentSessionKey: () => undefined })
      const tools = getTools(deps)
      await expect(invoke(tools, 'agents_spawn', { task: 'work' })).rejects.toThrow(/no parent session key available/)
    })
  })

  describe('agents_list', () => {
    it('returns all agents when no filter', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'agents_list', {})
      expect(deps.agents.list).toHaveBeenCalledWith(undefined)
      const parsed = parseResult(result) as any
      expect(parsed.agents).toHaveLength(1)
      expect(parsed.agents[0].sessionKey).toBe('sub-1')
    })

    it('passes parentSessionKey filter', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'agents_list', { parentSessionKey: 'agent:main:thread:t1' })
      expect(deps.agents.list).toHaveBeenCalledWith('agent:main:thread:t1')
    })
  })

  // ── notifications ───────────────────────────────────────────────────────

  describe('notifications_send', () => {
    it('calls deps.notifications.send and returns id', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'notifications_send', { title: 'Build done', severity: 'info' })
      expect(deps.notifications.send).toHaveBeenCalledWith({
        title: 'Build done',
        body: undefined,
        severity: 'info',
        entityId: undefined
      })
      const parsed = parseResult(result) as any
      expect(parsed.id).toBe('n-1')
    })

    it('passes severity, body, and entityId', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'notifications_send', {
        title: 'Deploy failed',
        body: 'Check logs',
        severity: 'error',
        entityId: 'deploy-123'
      })
      expect(deps.notifications.send).toHaveBeenCalledWith({
        title: 'Deploy failed',
        body: 'Check logs',
        severity: 'error',
        entityId: 'deploy-123'
      })
    })
  })

  // ── planning / issues ──────────────────────────────────────────────────

  describe('create_issue', () => {
    it('calls deps.planning.createIssue and returns the created issue', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'create_issue', {
        orgId: 'hexafield',
        projectId: 'sovereign',
        remote: 'origin',
        title: 'Fix the thing',
        body: 'Details here',
        labels: ['bug'],
        assignees: ['josh']
      })
      expect(deps.planning.createIssue).toHaveBeenCalledWith({
        orgId: 'hexafield',
        projectId: 'sovereign',
        remote: 'origin',
        title: 'Fix the thing',
        body: 'Details here',
        labels: ['bug'],
        assignees: ['josh']
      })
      const parsed = parseResult(result) as any
      expect(parsed.id).toBe('i-1')
    })
  })

  describe('update_planning_node', () => {
    it('calls deps.planning.updateIssue with partial fields', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'update_planning_node', {
        orgId: 'hexafield',
        projectId: 'sovereign',
        issueId: 'i-1',
        state: 'closed',
        labels: ['done']
      })
      expect(deps.planning.updateIssue).toHaveBeenCalledWith({
        orgId: 'hexafield',
        projectId: 'sovereign',
        issueId: 'i-1',
        state: 'closed',
        labels: ['done'],
        title: undefined,
        body: undefined
      })
      const parsed = parseResult(result) as any
      expect(parsed.state).toBe('closed')
    })
  })

  // ── orgs ────────────────────────────────────────────────────────────────

  describe('list_orgs', () => {
    it('returns orgs from deps.orgs.list', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'list_orgs', {})
      expect(deps.orgs.list).toHaveBeenCalled()
      const parsed = parseResult(result) as any
      expect(parsed.orgs).toHaveLength(1)
      expect(parsed.orgs[0].id).toBe('_global')
    })
  })

  // ── meetings ────────────────────────────────────────────────────────────

  describe('read_meeting', () => {
    it('lists meetings when no meetingId provided', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'read_meeting', { orgId: 'atlas' })
      expect(deps.meetings.list).toHaveBeenCalledWith('atlas', 20)
      const parsed = parseResult(result) as any
      expect(parsed.meetings).toHaveLength(1)
      expect(parsed.meetings[0].title).toBe('Standup')
    })

    it('respects explicit limit for listing', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      await invoke(tools, 'read_meeting', { orgId: 'atlas', limit: 5 })
      expect(deps.meetings.list).toHaveBeenCalledWith('atlas', 5)
    })

    it('reads a specific meeting when meetingId provided', async () => {
      const deps = makeDeps()
      const tools = getTools(deps)
      const result = await invoke(tools, 'read_meeting', { orgId: 'atlas', meetingId: 'm-1' })
      expect(deps.meetings.read).toHaveBeenCalledWith('atlas', 'm-1')
      expect(deps.meetings.list).not.toHaveBeenCalled()
      const parsed = parseResult(result) as any
      expect(parsed.transcript).toBe('hello')
      expect(parsed.summary).toBe('quick sync')
    })

    it('returns "not found" text for a missing meeting', async () => {
      const deps = makeDeps({
        meetings: {
          list: vi.fn().mockResolvedValue([]),
          read: vi.fn().mockResolvedValue(null)
        }
      })
      const tools = getTools(deps)
      const result = await invoke(tools, 'read_meeting', { orgId: 'atlas', meetingId: 'm-gone' })
      expect(result.content[0].text).toContain('not found')
      expect(result.content[0].text).toContain('m-gone')
    })
  })
})
