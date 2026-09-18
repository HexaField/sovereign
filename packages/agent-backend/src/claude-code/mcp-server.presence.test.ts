import { describe, it, expect, vi } from 'vitest'
import { createSovereignMcpServer, type SovereignToolDeps, type PresenceMcpDeps } from './mcp-server.js'

const INTERNAL_ID = 'aaaa-internal'
const GATEWAY_ID = 'bbbb-gateway'
const OTHER_ID = 'cccc-other'

function makePresence(overrides: Partial<PresenceMcpDeps> = {}): PresenceMcpDeps {
  return {
    internalThreadId: () => INTERNAL_ID,
    gatewayThreadId: () => GATEWAY_ID,
    tools: {
      reply_voice: vi.fn().mockResolvedValue({ delivered: true }),
      reply_ad4m: vi.fn().mockResolvedValue({ delivered: true })
    },
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

const PRESENCE_TOOLS = ['presence_reply_voice', 'presence_reply_ad4m']

describe('mcp-server presence tools', () => {
  describe('registration-time gating', () => {
    it('registers presence tools when session matches internal thread', () => {
      const deps = makeDeps({ presence: makePresence(), currentSessionKey: () => INTERNAL_ID })
      const names = Object.keys(getTools(deps))
      for (const expected of PRESENCE_TOOLS) {
        expect(names, `missing tool: ${expected}`).toContain(expected)
      }
    })

    it('excludes presence tools for the gateway session', () => {
      const deps = makeDeps({ presence: makePresence(), currentSessionKey: () => GATEWAY_ID })
      const names = Object.keys(getTools(deps))
      for (const absent of PRESENCE_TOOLS) {
        expect(names, `should not include: ${absent}`).not.toContain(absent)
      }
    })

    it('excludes presence tools for an unrelated session', () => {
      const deps = makeDeps({ presence: makePresence(), currentSessionKey: () => OTHER_ID })
      const names = Object.keys(getTools(deps))
      for (const absent of PRESENCE_TOOLS) {
        expect(names, `should not include: ${absent}`).not.toContain(absent)
      }
    })

    it('excludes presence tools when currentSessionKey returns undefined', () => {
      const deps = makeDeps({ presence: makePresence(), currentSessionKey: () => undefined as any })
      const names = Object.keys(getTools(deps))
      for (const absent of PRESENCE_TOOLS) {
        expect(names, `should not include: ${absent}`).not.toContain(absent)
      }
    })

    it('excludes presence tools when internalThreadId returns null', () => {
      const deps = makeDeps({
        presence: makePresence({ internalThreadId: () => null }),
        currentSessionKey: () => INTERNAL_ID
      })
      const names = Object.keys(getTools(deps))
      for (const absent of PRESENCE_TOOLS) {
        expect(names, `should not include: ${absent}`).not.toContain(absent)
      }
    })

    it('excludes presence tools when deps.presence omitted', () => {
      const deps = makeDeps({ presence: undefined })
      const names = Object.keys(getTools(deps))
      for (const absent of PRESENCE_TOOLS) {
        expect(names, `should not include: ${absent}`).not.toContain(absent)
      }
    })

    it('does NOT register removed watch tools', () => {
      const deps = makeDeps({ presence: makePresence() })
      const names = Object.keys(getTools(deps))
      expect(names).not.toContain('presence_watch')
      expect(names).not.toContain('presence_unwatch')
      expect(names).not.toContain('presence_watched')
    })
  })

  describe('internal session tool execution', () => {
    it('presence_reply_voice calls the reply handler', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_reply_voice', { text: 'hello world' })
      expect(presence.tools.reply_voice).toHaveBeenCalledWith('hello world', undefined)
    })

    it('presence_reply_voice passes deviceId when provided', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_reply_voice', { text: 'hello', deviceId: 'phone-1' })
      expect(presence.tools.reply_voice).toHaveBeenCalledWith('hello', { deviceId: 'phone-1' })
    })

    it('presence_reply_ad4m calls the ad4m reply handler', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_reply_ad4m', { text: 'response' })
      expect(presence.tools.reply_ad4m).toHaveBeenCalledWith('response', undefined)
    })

    it('presence_reply_ad4m passes perspectiveUuid and channelAddress', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const tools = getTools(deps)
      await invokeHandler(tools, 'presence_reply_ad4m', {
        text: 'reply',
        perspectiveUuid: 'p-uuid',
        channelAddress: 'ch-addr'
      })
      expect(presence.tools.reply_ad4m).toHaveBeenCalledWith('reply', {
        perspectiveUuid: 'p-uuid',
        channelAddress: 'ch-addr'
      })
    })
  })
})
