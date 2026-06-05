// Standalone MCP HTTP server. Mirrors Sovereign's own `/api/mcp` pattern so
// the SDK reconnects to a stable URL across daemon restarts.
//
// The sidecar exposes:
//   GET  /api/mcp/health  → liveness probe (returns Sovereign reachability)
//   POST /api/mcp         → Streamable HTTP MCP transport
//   GET  /api/mcp         → SSE upgrade (per spec)
//   DELETE /api/mcp       → session teardown

import express, { type Express, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildTools } from './tools.js'
import { createForwarder, type ForwarderConfig } from './forward.js'

export interface SidecarConfig {
  /** Port to listen on. Default 5802. */
  port: number
  /** Bind address. Default 127.0.0.1 — same loopback discipline as Sovereign. */
  host: string
  /** Sovereign daemon URL (where the RPC façade lives). */
  forwarder: ForwarderConfig
}

export function createSidecarApp(cfg: SidecarConfig): Express {
  const app = express()
  app.use(express.json({ limit: '8mb' }))

  const forward = createForwarder(cfg.forwarder)
  const tools = buildTools(forward)

  /**
   * Each MCP-over-HTTP session needs its own `McpServer` + transport pair
   * (the SDK keeps per-session state — capabilities, subscriptions).
   * `tools` are stateless schemas with the same forwarder closed over, so
   * we can register them on a fresh server per session without re-cost.
   */
  function makeMcpServer(): McpServer {
    const server = new McpServer({ name: 'sovereign', version: '1.0.0' })
    for (const t of tools) {
      // `tool()` from claude-agent-sdk returns `{ name, description, inputSchema, handler }`.
      // The MCP SDK's `tool()` method expects roughly the same shape — we
      // bridge them by re-registering each entry.
      const def = t as unknown as {
        name: string
        description?: string
        inputSchema?: Record<string, unknown>
        handler: (args: any) => Promise<{ content: any[]; isError?: boolean }>
      }
      server.tool(def.name, def.description ?? '', def.inputSchema ?? {}, async (args: any) => {
        const out = await def.handler(args)
        return { content: out.content, isError: out.isError }
      })
    }
    return server
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>()
  const isInit = (body: unknown): body is { method: 'initialize' } =>
    typeof body === 'object' && body !== null && (body as Record<string, unknown>).method === 'initialize'

  async function handle(req: Request, res: Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && sessions.has(sessionId)) {
      return sessions.get(sessionId)!.handleRequest(req, res, req.body)
    }
    if (!sessionId && isInit(req.body)) {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
      const server = makeMcpServer()
      await server.connect(transport)
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId)
      }
      await transport.handleRequest(req, res, req.body)
      if (transport.sessionId) sessions.set(transport.sessionId, transport)
      return
    }
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Bad MCP request — missing session or not initialize' },
      id: null
    })
  }

  app.post('/api/mcp', handle)
  app.get('/api/mcp', handle)
  app.delete('/api/mcp', (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId) {
      sessions.get(sessionId)?.close()
      sessions.delete(sessionId)
    }
    res.status(200).end()
  })

  // Liveness: ALWAYS returns 200 if the sidecar process itself is up; the
  // `sovereign` field reports whether the upstream is currently reachable.
  // This is the "what survives a Sovereign restart" signal — `sovereign: 'down'`
  // is recoverable, the catalog stays intact.
  app.get('/api/mcp/health', async (_req, res) => {
    let upstream: 'ok' | 'down' = 'down'
    try {
      const r = await fetch(`${cfg.forwarder.sovereignUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      })
      if (r.ok) upstream = 'ok'
    } catch {
      /* down */
    }
    res.json({ ok: true, sovereign: upstream, sessions: sessions.size, tools: tools.length })
  })

  return app
}

export async function startSidecar(cfg: SidecarConfig): Promise<{ close(): Promise<void> }> {
  const app = createSidecarApp(cfg)
  return new Promise((resolve, reject) => {
    const server = app.listen(cfg.port, cfg.host, () => {
      console.log(`[sovereign-mcp] listening on http://${cfg.host}:${cfg.port}/api/mcp`)
      console.log(`[sovereign-mcp] forwarding tool calls to ${cfg.forwarder.sovereignUrl}/api/mcp-rpc/*`)
      resolve({
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
          })
      })
    })
    server.on('error', reject)
  })
}
