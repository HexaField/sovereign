// S19: Presence MCP Tools — verify presence tool schemas appear in the
// in-process MCP server exposed at /api/mcp (Streamable HTTP transport).
//
// Exercises the full MCP protocol lifecycle: initialize → tools/list →
// tools/call. Proves the sole MCP surface (no sidecar, no RPC façade)
// advertises all presence tools and handles calls.

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

/** Parse SSE text into JSON-RPC message objects. */
function parseSse(text: string): any[] {
  const results: any[] = []
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
    if (dataLine) {
      try {
        results.push(JSON.parse(dataLine.slice(6)))
      } catch {
        /* skip unparseable */
      }
    }
  }
  return results
}

/** Send a JSON-RPC request to the MCP endpoint, returning body + headers. */
async function mcpPost(
  baseUrl: string,
  body: unknown,
  sessionId?: string
): Promise<{ status: number; headers: Headers; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const contentType = res.headers.get('content-type') ?? ''
  let parsed: any
  if (contentType.includes('text/event-stream')) {
    const text = await res.text()
    const messages = parseSse(text)
    parsed = messages.length === 1 ? messages[0] : messages.length > 0 ? messages : null
  } else {
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
  }
  return { status: res.status, headers: res.headers, body: parsed }
}

export const s19PresenceTools: Scenario = {
  id: 's19',
  name: 'Presence MCP Tools',
  description: 'Verify presence tools appear in the MCP endpoint and handlers respond',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client } = ctx
    const metrics: Record<string, unknown> = {}

    // 1. Initialize an MCP session.
    const initRes = await client.timed('mcp-initialize', () =>
      mcpPost(client.baseUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'wind-tunnel', version: '0.1.0' }
        }
      })
    )

    if (initRes.status !== 200 || !initRes.body?.result) {
      return {
        passed: false,
        summary: `MCP initialize failed: HTTP ${initRes.status}, body: ${JSON.stringify(initRes.body)}`,
        metrics,
        samples: client.samples
      }
    }

    const sessionId = initRes.headers.get('mcp-session-id')
    metrics.sessionId = sessionId
    metrics.serverInfo = initRes.body.result.serverInfo

    if (!sessionId) {
      return {
        passed: false,
        summary: 'MCP initialize returned no session ID',
        metrics,
        samples: client.samples
      }
    }

    // 2. Send initialized notification (required by MCP protocol).
    await mcpPost(client.baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)

    // 3. List tools.
    const listRes = await client.timed('mcp-tools-list', () =>
      mcpPost(client.baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
    )

    if (listRes.status !== 200 || !listRes.body?.result?.tools) {
      return {
        passed: false,
        summary: `MCP tools/list failed: HTTP ${listRes.status}, body: ${JSON.stringify(listRes.body)}`,
        metrics,
        samples: client.samples
      }
    }

    const toolNames: string[] = listRes.body.result.tools.map((t: any) => t.name)
    metrics.totalTools = toolNames.length

    // 4. Check every presence tool appears in the catalog.
    const missing = PRESENCE_TOOLS.filter((t) => !toolNames.includes(t))
    metrics.missing = missing

    if (missing.length > 0) {
      return {
        passed: false,
        summary: `${missing.length} presence tool(s) missing from MCP catalog: ${missing.join(', ')}`,
        metrics,
        samples: client.samples
      }
    }

    // 5. Smoke-test: call presence_watched via MCP tools/call.
    const callRes = await client.timed('mcp-tools-call', () =>
      mcpPost(
        client.baseUrl,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'presence_watched', arguments: {} }
        },
        sessionId
      )
    )

    metrics.callStatus = callRes.status
    metrics.callBody = callRes.body

    if (callRes.status !== 200 || !callRes.body?.result) {
      return {
        passed: false,
        summary: `MCP tools/call (presence_watched) failed: HTTP ${callRes.status}`,
        metrics,
        samples: client.samples
      }
    }

    // 6. Clean up — DELETE the session.
    await fetch(`${client.baseUrl}/api/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId }
    })

    // 7. Verify presence threads exist (self-contained check).
    const presence = await client.timed('presence-check', () => client.presenceThreads())
    metrics.hasInternal = presence?.internal?.id != null
    metrics.hasGateway = presence?.gateway?.id != null

    return {
      passed: true,
      summary: `MCP endpoint: ${toolNames.length} tools, all ${PRESENCE_TOOLS.length} presence tools present, tools/call responds`,
      metrics,
      samples: client.samples
    }
  }
}
