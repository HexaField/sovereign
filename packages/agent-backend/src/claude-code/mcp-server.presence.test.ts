// Tests for presence-tool registration and session-role gating in the
// Sovereign MCP server. Verifies that:
//  - All 7 presence tools appear when deps.presence exists
//  - Internal-only tools refuse calls from a gateway session
//  - Gateway-only tools refuse calls from an internal session
//  - Both tool sets work from their intended session

import { describe, it, expect, vi } from 'vitest'
import { createSovereignMcpServer, type SovereignToolDeps, type PresenceMcpDeps } from './mcp-server.js'

const INTERNAL_ID = 'aaaa-internal'
const GATEWAY_ID = 'bbbb-gateway'
const OTHER_ID = 'cccc-other'

function makePresence(overrides: Partial<PresenceMcpDeps> = {}): PresenceMcpDeps {
  return {
    internalThreadId: () => INTERNAL_ID,
    gatewayThreadId: () => GATEWAY_ID,
    watch: {
      add: vi.fn().mockReturnValue({ threadId: 't1', addedAt: '2026-01-01T00:00:00Z' }),
      remove: vi.fn().mockReturnValue(true),
      list: vi.fn().mockReturnValue([])
    },
    tools: {
      reply_voice: vi.fn().mockResolvedValue({ delivered: true }),
      reply_ad4m: vi.fn().mockResolvedValue({ delivered: true }),
      reply_text: vi.fn().mockResolvedValue({ delivered: true }),
      reply_webhook: vi.fn().mockResolvedValue({ delivered: false, reason: 'not-implemented' })
    },
    forwardToInternal: vi.fn().mockResolvedValue({ delivered: true }),
    internalHistory: vi.fn().mockResolvedValue({ turns: [{ role: 'user', content: 'hello' }] }),
    resolveThreadId: vi.fn().mockImplementation((id: string) => id),
    ...overrides
  }
}

function makeDeps(overrides: Partial<SovereignToolDeps> = {}): SovereignToolDeps {
  return {
    cron: {
      createUserMessageCron: vi.fn().mockResolvedValue({ id: 'c1', schedule: 'once' }),
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      send: vi.fn().mockResolvedValue(undefined),
      history: vi.fn().mockResolvedValue([])
    },
    agents: {
      list: vi.fn().mockResolvedValue([]),
      spawn: vi.fn().mockResolvedValue({ sessionKey: 'sub-1' })
    },
    notifications: { send: vi.fn().mockReturnValue({ id: 'n1' }) },
    planning: {
      createIssue: vi.fn().mockResolvedValue({ id: 'i1', orgId: 'o', projectId: 'p', title: 'T' }),
      updateIssue: vi.fn().mockResolvedValue({ id: 'i1', orgId: 'o', projectId: 'p', title: 'T', state: 'open' })
    },
    orgs: { list: vi.fn().mockReturnValue([]) },
    meetings: { list: vi.fn().mockResolvedValue([]), read: vi.fn().mockResolvedValue(null) },
    browser: {
      open: vi.fn().mockResolvedValue({ sessionId: 'b1', url: 'x', title: 'X', summary: '' }),
      act: vi.fn().mockResolvedValue({ message: 'ok' }),
      close: vi.fn().mockResolvedValue(undefined)
    },
    currentSessionKey: () => INTERNAL_ID,
    ...overrides
  }
}

/** Extract registered tool handlers from the MCP server instance. */
function getTools(deps: SovereignToolDeps): Record<string, { callback: Function }> {
  const cfg = createSovereignMcpServer(deps) as any
  return cfg.instance?._registeredTools ?? cfg.instance?.registeredTools ?? {}
}

function invokeHandler(tools: Record<string, any>, name: string, args: Record<string, unknown> = {}) {
  const handler = tools[name]?.callback ?? tools[name]?.handler
  if (typeof handler !== 'function') {
    throw new Error(`handler "${name}" not found on MCP server instance`)
  }
  return handler(args, {})
}

const PRESENCE_INTERNAL_TOOLS = [
  'presence_reply_voice',
  'presence_reply_ad4m',
  'presence_reply_text',
  'presence_reply_webhook',
  'presence_watch',
  'presence_unwatch',
  'presence_watched'
]

const PRESENCE_GATEWAY_TOOLS = ['presence_internal_send', 'presence_internal_history']

const ALL_PRESENCE_TOOLS = [...PRESENCE_INTERNAL_TOOLS, ...PRESENCE_GATEWAY_TOOLS]

describe('mcp-server presence tools', () => {
  it('registers all 9 presence tools when deps.presence exists', () => {
    const deps = makeDeps({ presence: makePresence() })
    const tools = getTools(deps)
    const names = Object.keys(tools)
    for (const expected of ALL_PRESENCE_TOOLS) {
      expect(names, `missing tool: ${expected}`).toContain(expected)
    }
  })

  it('does NOT register presence tools when deps.presence omitted', () => {
    const deps = makeDeps({ presence: undefined })
    const tools = getTools(deps)
    const names = Object.keys(tools)
    for (const absent of ALL_PRESENCE_TOOLS) {
      expect(names, `should not include: ${absent}`).not.toContain(absent)
    }
  })

  describe('internal-only tools refuse from gateway session', () => {
    for (const toolName of PRESENCE_INTERNAL_TOOLS) {
      it(`${toolName} refuses from gateway session`, async () => {
        const deps = makeDeps({
          presence: makePresence(),
          currentSessionKey: () => GATEWAY_ID
        })
        const tools = getTools(deps)
        const minArgs: Record<string, unknown> = {}
        if (toolName === 'presence_reply_webhook') minArgs.source = 'test'
        if (toolName.includes('reply')) minArgs.text = 'hello'
        if (toolName === 'presence_watch' || toolName === 'presence_unwatch') minArgs.threadId = 't1'
        const result = await invokeHandler(tools, toolName, minArgs)
        expect(JSON.stringify(result.content)).toContain('this tool can only be used from the internal session')
      })
    }
  })

  describe('internal-only tools succeed from internal session', () => {
    it('presence_reply_voice calls the reply handler', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_reply_voice', { text: 'hello world' })
      expect(presence.tools.reply_voice).toHaveBeenCalledWith('hello world', undefined)
    })

    it('presence_watched returns the watch list', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_watched', {})
      expect(presence.watch.list).toHaveBeenCalled()
    })
  })

  describe('gateway-only tools refuse from internal session', () => {
    for (const toolName of PRESENCE_GATEWAY_TOOLS) {
      it(`${toolName} refuses from internal session`, async () => {
        const deps = makeDeps({
          presence: makePresence(),
          currentSessionKey: () => INTERNAL_ID
        })
        const tools = getTools(deps)
        const result = await invokeHandler(tools, toolName, { text: 'hello', limit: 5 })
        expect(JSON.stringify(result.content)).toContain('this tool can only be used from the gateway session')
      })
    }
  })

  describe('gateway-only tools succeed from gateway session', () => {
    it('presence_internal_send forwards to internal', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => GATEWAY_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_internal_send', { text: 'remember this' })
      expect(presence.forwardToInternal).toHaveBeenCalledWith('remember this', undefined)
    })

    it('presence_internal_history reads internal turns', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => GATEWAY_ID })
      const tools = getTools(deps)
      const result = await invokeHandler(tools, 'presence_internal_history', { limit: 10 })
      expect(presence.internalHistory).toHaveBeenCalledWith(10)
      const text = JSON.parse(result.content[0].text)
      expect(text.turns).toBeDefined()
    })
  })

  describe('gateway-only tools refuse from unrelated session', () => {
    it('presence_internal_send refuses from an unrelated thread', async () => {
      const deps = makeDeps({
        presence: makePresence(),
        currentSessionKey: () => OTHER_ID
      })
      const tools = getTools(deps)
      const result = await invokeHandler(tools, 'presence_internal_send', { text: 'test' })
      expect(JSON.stringify(result.content)).toContain('this tool can only be used from the gateway session')
    })
  })
})
