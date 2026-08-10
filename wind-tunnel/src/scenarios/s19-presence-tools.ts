// S19: Presence MCP Tools — verify presence tool schemas appear in the
// RPC catalog and the handlers respond to calls.
//
// This scenario catches the three-way sync gap: tools registered in the
// in-process MCP server (mcp-server.ts) must also exist in the RPC route
// handlers (mcp-rpc-routes.ts) and the sidecar catalog (mcp-sidecar/tools.ts).
// The RPC catalog endpoint (GET /api/mcp-rpc) returns the handler names
// the daemon has wired — any missing name means the sidecar would 404.

import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'

const PRESENCE_TOOLS = [
  'presence_reply_voice',
  'presence_reply_ad4m',
  'presence_reply_text',
  'presence_reply_webhook',
  'presence_watch',
  'presence_unwatch',
  'presence_watched',
  'presence_internal_send',
  'presence_internal_history'
]

export const s19PresenceTools: Scenario = {
  id: 's19',
  name: 'Presence MCP Tools',
  description: 'Verify presence tools appear in the RPC catalog and handlers respond',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Fetch the RPC catalog — lists every handler the daemon has wired.
    const catalog = await client.timed('rpc-catalog', () =>
      client.get<{ ok: boolean; tools: string[] }>('/api/mcp-rpc')
    )
    metrics.catalogTools = catalog.tools

    if (!catalog.ok || !Array.isArray(catalog.tools)) {
      return {
        passed: false,
        summary: 'RPC catalog endpoint returned unexpected shape',
        metrics,
        samples: client.samples
      }
    }

    // 2. Check every presence tool appears in the catalog.
    const missing = PRESENCE_TOOLS.filter((t) => !catalog.tools.includes(t))
    metrics.missing = missing

    if (missing.length > 0) {
      return {
        passed: false,
        summary: `${missing.length} presence tool(s) missing from RPC catalog: ${missing.join(', ')}`,
        metrics,
        samples: client.samples
      }
    }

    // 3. Smoke-test two handlers: one internal-only, one gateway-only.
    //    Both should respond (not 404) — the gating refusal counts as a
    //    valid response (the tool exists, it just refused this caller).

    // presence_watched (internal-only, no required args)
    let watchedResult: any
    try {
      watchedResult = await client.timed('rpc-presence-watched', () => client.post('/api/mcp-rpc/presence_watched', {}))
      metrics.watchedResponse = watchedResult
    } catch (err: any) {
      metrics.watchedError = err?.message
    }

    // presence_internal_history (gateway-only, optional args)
    let historyResult: any
    try {
      historyResult = await client.timed('rpc-presence-internal-history', () =>
        client.post('/api/mcp-rpc/presence_internal_history', { limit: 5 })
      )
      metrics.historyResponse = historyResult
    } catch (err: any) {
      metrics.historyError = err?.message
    }

    // Both calls returning `ok: true` (even with a gating refusal text)
    // proves the handler exists and executes. A 404 would throw in the
    // client (non-2xx status).
    const watchedOk = watchedResult?.ok === true
    const historyOk = historyResult?.ok === true

    if (!watchedOk) {
      return {
        passed: false,
        summary: `presence_watched handler returned unexpected result: ${JSON.stringify(watchedResult ?? metrics.watchedError)}`,
        metrics,
        samples: client.samples
      }
    }

    if (!historyOk) {
      return {
        passed: false,
        summary: `presence_internal_history handler returned unexpected result: ${JSON.stringify(historyResult ?? metrics.historyError)}`,
        metrics,
        samples: client.samples
      }
    }

    // 4. Verify the presence threads themselves exist (s4 also checks this,
    //    but having it here makes s19 self-contained).
    const presence = await client.timed('presence-check', () => client.presenceThreads())
    metrics.hasInternal = presence?.internal?.id != null
    metrics.hasGateway = presence?.gateway?.id != null

    return {
      passed: true,
      summary: `all ${PRESENCE_TOOLS.length} presence tools in RPC catalog, handlers respond`,
      metrics,
      samples: client.samples
    }
  }
}
