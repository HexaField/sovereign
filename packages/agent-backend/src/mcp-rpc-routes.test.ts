// Tests for the MCP RPC routes (POST /api/mcp-rpc/:tool).
//
// Covers:
//  1. Presence handler registration and gating
//  2. Catalog parity — every tool in mcp-server.ts has a matching handler
//     in buildHandlers(), so the sidecar never advertises a tool that 404s.

import { describe, it, expect, vi } from 'vitest'
import { createMcpRpcRoutes } from './mcp-rpc-routes.js'
import { createSovereignMcpServer, type SovereignToolDeps, type PresenceMcpDeps } from './claude-code/mcp-server.js'

const INTERNAL_ID = 'aaaa-internal'
const GATEWAY_ID = 'bbbb-gateway'

function makePresence(): PresenceMcpDeps {
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
    internalHistory: vi.fn().mockResolvedValue({ turns: [] }),
    resolveThreadId: (id: string) => id
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
    presence: makePresence(),
    ...overrides
  }
}

describe('mcp-rpc-routes', () => {
  describe('catalog parity — every MCP tool has an RPC handler', () => {
    it('RPC handler map covers all tools registered by createSovereignMcpServer', () => {
      const deps = makeDeps()
      // Extract tool names from the in-process MCP server.
      const mcpCfg = createSovereignMcpServer(deps) as any
      const registered = mcpCfg.instance?._registeredTools ?? mcpCfg.instance?.registeredTools ?? {}
      const mcpToolNames = new Set(Object.keys(registered))

      // Extract handler names from the RPC route builder.
      // The GET /api/mcp-rpc catalog endpoint returns sorted handler names.
      // We can inspect the router's stack to find the GET handler, or build
      // the handlers directly. Building the router and checking the catalog
      // endpoint exercises the real path.
      const router = createMcpRpcRoutes(deps) as any
      // Walk the router stack to find the GET /api/mcp-rpc handler.
      let rpcCatalog: string[] = []
      for (const layer of router.stack ?? []) {
        if (layer.route?.path === '/api/mcp-rpc' && layer.route?.methods?.get) {
          // Invoke the handler with a mock res to capture the catalog.
          const mockRes = {
            json(body: any) {
              rpcCatalog = body.tools
            }
          }
          layer.route.stack[0].handle({}, mockRes)
          break
        }
      }

      expect(rpcCatalog.length).toBeGreaterThan(0)
      const rpcToolNames = new Set(rpcCatalog)

      // Every MCP tool must have an RPC handler.
      for (const name of mcpToolNames) {
        expect(rpcToolNames, `MCP tool "${name}" has no matching RPC handler`).toContain(name)
      }
    })
  })

  describe('presence handlers', () => {
    /** Invoke an RPC handler directly by walking the router stack. */
    async function invokeRpc(
      deps: SovereignToolDeps,
      toolName: string,
      body: Record<string, unknown> = {}
    ): Promise<{ status: number; body: any }> {
      const router = createMcpRpcRoutes(deps) as any
      let captured = { status: 200, body: {} as any }
      const mockReq = { params: { tool: toolName }, headers: {}, body } as any
      const mockRes = {
        status(code: number) {
          captured.status = code
          return this
        },
        json(data: any) {
          captured.body = data
        }
      } as any

      // Find the POST /api/mcp-rpc/:tool handler.
      for (const layer of router.stack ?? []) {
        if (layer.route?.path === '/api/mcp-rpc/:tool' && layer.route?.methods?.post) {
          await layer.route.stack[0].handle(mockReq, mockRes, () => {})
          return captured
        }
      }
      throw new Error('POST /api/mcp-rpc/:tool route not found')
    }

    it('presence_internal_send succeeds from gateway session', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => GATEWAY_ID })
      const { status, body } = await invokeRpc(deps, 'presence_internal_send', { text: 'hello' })
      expect(status).toBe(200)
      expect(body.ok).toBe(true)
      expect(presence.forwardToInternal).toHaveBeenCalledWith('hello', undefined)
    })

    it('presence_internal_send refuses from internal session', async () => {
      const deps = makeDeps({ presence: makePresence(), currentSessionKey: () => INTERNAL_ID })
      const { body } = await invokeRpc(deps, 'presence_internal_send', { text: 'hello' })
      expect(body.ok).toBe(true) // Returns a refusal text, not an HTTP error.
      const text = body.content?.[0]?.text ?? ''
      expect(text).toContain('gateway session')
    })

    it('presence_reply_voice succeeds from internal session', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const { body } = await invokeRpc(deps, 'presence_reply_voice', { text: 'hi' })
      expect(body.ok).toBe(true)
      expect(presence.tools.reply_voice).toHaveBeenCalledWith('hi', undefined)
    })

    it('presence_reply_voice refuses from gateway session', async () => {
      const deps = makeDeps({ presence: makePresence(), currentSessionKey: () => GATEWAY_ID })
      const { body } = await invokeRpc(deps, 'presence_reply_voice', { text: 'hi' })
      const text = body.content?.[0]?.text ?? ''
      expect(text).toContain('internal session')
    })

    it('presence_watched returns watch list from internal session', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => INTERNAL_ID })
      const { body } = await invokeRpc(deps, 'presence_watched', {})
      expect(body.ok).toBe(true)
      expect(presence.watch.list).toHaveBeenCalled()
    })

    it('presence_internal_history reads turns from gateway session', async () => {
      const presence = makePresence()
      const deps = makeDeps({ presence, currentSessionKey: () => GATEWAY_ID })
      const { body } = await invokeRpc(deps, 'presence_internal_history', { limit: 5 })
      expect(body.ok).toBe(true)
      expect(presence.internalHistory).toHaveBeenCalledWith(5)
    })

    it('returns 404 for unknown tool', async () => {
      const deps = makeDeps()
      const { status, body } = await invokeRpc(deps, 'nonexistent_tool', {})
      expect(status).toBe(404)
      expect(body.ok).toBe(false)
    })
  })
})
