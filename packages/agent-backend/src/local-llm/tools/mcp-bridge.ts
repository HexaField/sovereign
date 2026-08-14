// Generic HTTP MCP bridge for the local-llm backend.
//
// Connects to any MCP server that speaks Streamable HTTP (JSON-RPC 2.0 over
// HTTP POST with optional SSE responses). Discovers tools via `tools/list`,
// converts them to OpenAI function-calling schemas, and proxies `tools/call`
// requests. Handles lazy initialization, reconnection, and auth headers.
//
// Primary use: bridging AD4M's MCP server to local models.

import type { ToolSchema } from '../inference.js'
import type { ToolResult } from './index.js'

// ── Types ───────────────────────────────────────────────────────────────

interface McpJsonRpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: any
  error?: { code: number; message: string; data?: any }
}

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpBridgeConfig {
  /** Display name for this bridge (e.g. "ad4m"). Used as tool name prefix. */
  name: string
  /** HTTP endpoint URL (e.g. "http://127.0.0.1:3101/mcp"). */
  endpoint: string
  /** Optional bearer token for Authorization header. */
  authToken?: string
  /** Request timeout in ms. Default: 30000. */
  timeoutMs?: number
  /** Max characters of tool result output. Default: 48000. */
  maxOutputChars?: number
}

interface McpSession {
  sessionId: string
  tools: McpToolDefinition[]
  schemas: ToolSchema[]
  /** Maps prefixed tool name → raw MCP tool name. */
  nameMap: Map<string, string>
  connectedAt: number
}

// ── SSE parser ──────────────────────────────────────────────────────────
// The MCP server may respond with text/event-stream (SSE). Parse the first
// JSON-RPC message from the stream.

async function parseSSE(response: Response): Promise<McpJsonRpcResponse> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body from MCP server')

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.substring(5).trim()
          if (payload.length > 0) {
            try {
              const parsed = JSON.parse(payload)
              if (parsed.jsonrpc) {
                reader.cancel()
                return parsed as McpJsonRpcResponse
              }
            } catch {
              // incomplete JSON — continue
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // Try remaining buffer
  for (const line of buffer.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.substring(5).trim()
      if (payload.length > 0) {
        try {
          return JSON.parse(payload) as McpJsonRpcResponse
        } catch {
          /* skip */
        }
      }
    }
  }

  throw new Error('SSE stream ended without JSON-RPC data')
}

// ── MCP HTTP transport ──────────────────────────────────────────────────

let requestIdCounter = 0

async function mcpRequest(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
  authToken?: string,
  timeoutMs = 30_000
): Promise<McpJsonRpcResponse> {
  const id = ++requestIdCounter
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  })

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`)
  }

  const ct = response.headers.get('content-type') ?? ''
  if (ct.includes('text/event-stream')) {
    return parseSSE(response)
  }
  return (await response.json()) as McpJsonRpcResponse
}

async function mcpNotify(
  endpoint: string,
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
  authToken?: string
): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`

  await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params })
  })
}

// ── MCP bridge ──────────────────────────────────────────────────────────

/** Convert an MCP tool definition to an OpenAI function-calling schema. */
function mcpToolToSchema(tool: McpToolDefinition, prefix: string): ToolSchema {
  return {
    type: 'function',
    function: {
      name: `${prefix}_${tool.name}`,
      description: tool.description ?? `MCP tool: ${tool.name}`,
      parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
    }
  }
}

export function createMcpBridge(config: McpBridgeConfig) {
  const { name, endpoint, timeoutMs = 30_000, maxOutputChars = 48_000 } = config
  let session: McpSession | null = null
  let connecting = false
  let lastError: string | null = null

  /** Initialize the MCP session — handshake + tool discovery. */
  async function connect(): Promise<McpSession> {
    if (connecting) throw new Error(`${name} MCP bridge already connecting`)
    connecting = true
    try {
      // Phase 1: initialize
      const initResp = await mcpRequest(
        endpoint,
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: { roots: { listChanged: false } },
          clientInfo: { name: `sovereign-local-llm-${name}`, version: '1.0.0' }
        },
        undefined,
        config.authToken,
        timeoutMs
      )

      if (initResp.error) {
        throw new Error(`MCP initialize error: ${initResp.error.message}`)
      }

      // Extract session ID from the response or from an earlier call
      // (the server sets it via Mcp-Session-Id header, but our fetch wrapper
      // doesn't expose response headers — we'll use an empty string and let
      // subsequent calls work without it if the server allows).
      // For AD4M's server, sessions track by the header, so we need to get it.
      // Workaround: make a raw fetch to get the header.
      let sessionId = ''
      try {
        const rawHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream'
        }
        if (config.authToken) rawHeaders['Authorization'] = `Bearer ${config.authToken}`
        const rawResp = await fetch(endpoint, {
          method: 'POST',
          headers: rawHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++requestIdCounter,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: { roots: { listChanged: false } },
              clientInfo: { name: `sovereign-local-llm-${name}`, version: '1.0.0' }
            }
          }),
          signal: AbortSignal.timeout(timeoutMs)
        })
        sessionId = rawResp.headers.get('mcp-session-id') ?? ''
      } catch {
        // If the second init call fails, continue without session ID
      }

      // Phase 2: notifications/initialized handshake
      await mcpNotify(endpoint, 'notifications/initialized', {}, sessionId, config.authToken)

      // Phase 3: discover tools
      const toolsResp = await mcpRequest(endpoint, 'tools/list', {}, sessionId, config.authToken, timeoutMs)
      const tools: McpToolDefinition[] = toolsResp.result?.tools ?? []

      // Build schemas + name map
      const schemas = tools.map((t) => mcpToolToSchema(t, name))
      const nameMap = new Map<string, string>()
      for (const tool of tools) {
        nameMap.set(`${name}_${tool.name}`, tool.name)
      }

      session = { sessionId, tools, schemas, nameMap, connectedAt: Date.now() }
      lastError = null
      console.log(`[local-llm] ${name} MCP bridge connected — ${tools.length} tools discovered`)
      return session
    } catch (err) {
      lastError = (err as Error).message
      console.warn(`[local-llm] ${name} MCP bridge connection failed: ${lastError}`)
      throw err
    } finally {
      connecting = false
    }
  }

  /** Ensure the session exists — lazy connect on first use. */
  async function ensureSession(): Promise<McpSession> {
    if (session) return session
    return connect()
  }

  return {
    /** The bridge name/prefix (e.g. "ad4m"). */
    name,

    /** Get tool schemas. Returns empty array when not connected. */
    async getSchemas(): Promise<ToolSchema[]> {
      try {
        const s = await ensureSession()
        return s.schemas
      } catch {
        return []
      }
    },

    /** Get tool schemas synchronously — returns cached schemas or empty. */
    getCachedSchemas(): ToolSchema[] {
      return session?.schemas ?? []
    },

    /** Whether this bridge holds a live session. */
    get connected(): boolean {
      return session != null
    },

    /** Last connection error, if any. */
    get error(): string | null {
      return lastError
    },

    /** Force reconnect — useful when the MCP server restarts. */
    async reconnect(): Promise<void> {
      session = null
      await connect()
    },

    /** Execute a tool call. */
    async execute(prefixedName: string, input: Record<string, unknown>): Promise<ToolResult> {
      let s: McpSession
      try {
        s = await ensureSession()
      } catch (err) {
        return {
          content: `${name} MCP server unavailable: ${(err as Error).message}`,
          error: 'mcp_unavailable'
        }
      }

      const rawName = s.nameMap.get(prefixedName)
      if (!rawName) {
        return {
          content: `Unknown ${name} tool: ${prefixedName}`,
          error: 'unknown_tool'
        }
      }

      try {
        const resp = await mcpRequest(
          endpoint,
          'tools/call',
          { name: rawName, arguments: input },
          s.sessionId,
          config.authToken,
          timeoutMs
        )

        if (resp.error) {
          return {
            content: `${name} tool error: ${resp.error.message}`,
            error: resp.error.message
          }
        }

        // Extract text from the MCP result format
        let output = ''
        const result = resp.result
        if (result?.content) {
          const parts = Array.isArray(result.content) ? result.content : [result.content]
          output = parts
            .map((p: any) => {
              if (typeof p === 'string') return p
              if (p?.text) return p.text
              return JSON.stringify(p)
            })
            .join('\n')
        } else if (result != null) {
          output = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }

        if (output.length > maxOutputChars) {
          output = output.slice(0, maxOutputChars) + '\n[output truncated]'
        }

        return { content: output || '(empty result)' }
      } catch (err) {
        const msg = (err as Error).message
        // If the connection died, clear the session so next call reconnects
        if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('socket')) {
          session = null
        }
        return { content: `${name} tool call failed: ${msg}`, error: msg }
      }
    },

    /** Check whether a tool name belongs to this bridge. */
    owns(toolName: string): boolean {
      return toolName.startsWith(`${name}_`)
    }
  }
}

export type McpBridge = ReturnType<typeof createMcpBridge>
