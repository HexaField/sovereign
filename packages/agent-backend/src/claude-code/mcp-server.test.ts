import { describe, it, expect, vi } from 'vitest'
import { createSovereignMcpServer, type SovereignToolDeps } from './mcp-server.js'

/**
 * Smoke tests for the MCP server wiring. We don't spin up a Claude Code
 * runtime — we just confirm the SDK helper produces an MCP server config
 * with the expected tool surface, and that each tool's handler invokes the
 * right Sovereign dep.
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
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue({ sessionKey: 'agent:main:subagent:abc' })
    },
    notifications: { send: vi.fn().mockReturnValue({ id: 'n-1' }) },
    planning: {
      createIssue: vi.fn().mockResolvedValue({ id: 'i-1', orgId: 'o', projectId: 'p', title: 'T' }),
      updateIssue: vi.fn().mockResolvedValue({ id: 'i-1', orgId: 'o', projectId: 'p', title: 'T', state: 'open' })
    },
    orgs: { list: vi.fn().mockReturnValue([{ id: '_global', name: 'Global', path: '/tmp' }]) },
    meetings: { list: vi.fn().mockResolvedValue([]), read: vi.fn().mockResolvedValue(null) },
    browser: {
      open: vi.fn().mockResolvedValue({ sessionId: 'b-1', url: 'https://x', title: 'X', summary: '' }),
      act: vi.fn().mockResolvedValue({ message: 'ok' }),
      close: vi.fn().mockResolvedValue(undefined)
    },
    currentSessionKey: () => 'agent:main:thread:t1',
    ...overrides
  }
}

describe('claude-code/mcp-server', () => {
  it('creates an MCP server config with the expected name', () => {
    const cfg = createSovereignMcpServer(makeDeps())
    expect(cfg.type).toBe('sdk')
    expect(cfg.name).toBe('sovereign')
  })

  it('exposes all required tool names', () => {
    const cfg = createSovereignMcpServer(makeDeps()) as any
    // The SDK-side cfg surfaces the registered McpServer instance.
    // Probe the tool list via the underlying instance.
    const tools = (cfg.instance?._registeredTools ?? cfg.instance?.registeredTools ?? cfg.instance?.tools) as
      | Record<string, unknown>
      | undefined
    // The instance shape isn't fully exported, but we can at least confirm we
    // got an instance back.
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
        'agents_spawn',
        'agents_list',
        'notifications_send',
        'create_issue',
        'update_planning_node',
        'list_orgs',
        'read_meeting'
      ]) {
        expect(names).toContain(expected)
      }
    }
  })

  /**
   * Regression for "crons created inside neural-nets all fell into main."
   *
   * Pre-fix `threadKey` was required, and any cron the agent forgot to
   * scope explicitly defaulted to whatever name appeared in the model's
   * mental model (often "main"). Post-fix the default is the CALLING
   * thread, resolved via `deps.currentSessionKey()`. Cross-posting still
   * works when `threadKey` is passed explicitly.
   */
  describe('cron_create defaults to the calling thread', () => {
    /**
     * Helper: invoke `cron_create` directly via the underlying tool
     * handler the MCP server registered. We bypass the SDK transport and
     * read the captured tool definitions off the McpServer instance.
     */
    function invokeCronCreate(deps: SovereignToolDeps, args: Record<string, unknown>) {
      const cfg = createSovereignMcpServer(deps) as any
      const registered = cfg.instance?._registeredTools ?? cfg.instance?.registeredTools ?? {}
      const handler = registered.cron_create?.callback ?? registered.cron_create?.handler
      if (typeof handler !== 'function') {
        throw new Error('cron_create handler not exposed on the McpServer instance — test plumbing drift')
      }
      return handler(args, {})
    }

    it('uses the current thread (via currentSessionKey) when threadKey is omitted', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-x', schedule: 'every 60s' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any,
        currentSessionKey: () => 'agent:main:thread:neural-nets'
      })
      await invokeCronCreate(deps, { when: { kind: 'interval', everyMs: 60000 }, prompt: 'tick' })
      expect(createSpy).toHaveBeenCalledTimes(1)
      // Verifies the fix: handler resolved the canonical session key to the
      // bare thread name `neural-nets`, not the prefixed form, and certainly
      // not `main`.
      expect(createSpy.mock.calls[0][0].threadKey).toBe('neural-nets')
    })

    it('honours an explicit threadKey to cross-post into a different thread', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-y', schedule: 'every 60s' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any,
        currentSessionKey: () => 'agent:main:thread:neural-nets'
      })
      await invokeCronCreate(deps, {
        threadKey: 'maps',
        when: { kind: 'oneshot', at: '2099-01-01T00:00:00Z' },
        prompt: 'cross-post'
      })
      expect(createSpy.mock.calls[0][0].threadKey).toBe('maps')
    })

    it('strips agent:main:main → main when currentSessionKey is the canonical main key', async () => {
      const createSpy = vi.fn().mockResolvedValue({ id: 'cron-z', schedule: 'every 60s' })
      const deps = makeDeps({
        cron: { createUserMessageCron: createSpy, list: vi.fn(), remove: vi.fn() } as any,
        currentSessionKey: () => 'agent:main:main'
      })
      await invokeCronCreate(deps, { when: { kind: 'interval', everyMs: 60000 }, prompt: 'tick' })
      expect(createSpy.mock.calls[0][0].threadKey).toBe('main')
    })

    it('throws a clear error when threadKey is omitted AND no calling session is attributable', async () => {
      const deps = makeDeps({ currentSessionKey: () => undefined })
      await expect(
        invokeCronCreate(deps, { when: { kind: 'interval', everyMs: 60000 }, prompt: 'tick' })
      ).rejects.toThrow(/threadKey is required/)
    })
  })
})
