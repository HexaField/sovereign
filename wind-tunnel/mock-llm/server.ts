#!/usr/bin/env -S npx tsx
// Mock Anthropic API — implements /v1/messages with SSE streaming.
//
// Returns scripted responses keyed by scenario. The SDK sends standard
// Anthropic message requests; this server responds with the same SSE
// event protocol Claude uses.
//
// Environment:
//   PORT          — listen port (default 8900)
//   MOCK_VERBOSE  — set to "1" for request logging

import http from 'node:http'

const PORT = Number(process.env.PORT ?? 8900)
const VERBOSE = process.env.MOCK_VERBOSE === '1'

// ── Request log (for assertions) ────────────────────────────────────
interface LogEntry {
  timestamp: number
  model: string
  messages: unknown[]
  tools?: unknown[]
  system?: string
}
const requestLog: LogEntry[] = []

// ── Scripted response registry ──────────────────────────────────────
// Scripts are keyed by a matcher function over the last user message.
// First match wins. Default: echo the user message back.

interface Script {
  match: (lastUserMessage: string, messages: any[]) => boolean
  respond: (lastUserMessage: string, messages: any[], model: string) => ResponsePlan
}

interface ResponsePlan {
  text?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  stopReason?: 'end_turn' | 'tool_use'
}

const scripts: Script[] = []

/** Register a response script. First match wins. */
export function addScript(script: Script) {
  scripts.push(script)
}

function planResponse(userMsg: string, messages: any[], model: string): ResponsePlan {
  for (const s of scripts) {
    if (s.match(userMsg, messages)) return s.respond(userMsg, messages, model)
  }
  // Default: echo
  return { text: `[mock] echo: ${userMsg}`, stopReason: 'end_turn' }
}

// ── SSE streaming helpers ───────────────────────────────────────────

function sseWrite(res: http.ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function streamResponse(res: http.ServerResponse, plan: ResponsePlan, model: string) {
  const messageId = `msg_mock_${Date.now()}`

  // message_start
  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    }
  })

  if (plan.toolUse) {
    // Tool use content block
    sseWrite(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: plan.toolUse.id, name: plan.toolUse.name, input: {} }
    })

    const inputJson = JSON.stringify(plan.toolUse.input)
    sseWrite(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson }
    })

    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  }

  if (plan.text) {
    const blockIndex = plan.toolUse ? 1 : 0

    sseWrite(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'text', text: '' }
    })

    // Stream text in chunks for realism
    const chunkSize = 20
    for (let i = 0; i < plan.text.length; i += chunkSize) {
      const chunk = plan.text.slice(i, i + chunkSize)
      sseWrite(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: chunk }
      })
    }

    sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
  }

  // message_delta + message_stop
  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: plan.stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: Math.ceil((plan.text?.length ?? 10) / 4) }
  })

  sseWrite(res, 'message_stop', { type: 'message_stop' })
}

// ── HTTP server ─────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // Health
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', requests: requestLog.length }))
    return
  }

  // Request log (for test assertions)
  if (url.pathname === '/mock/log' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(requestLog))
    return
  }

  // Clear log
  if (url.pathname === '/mock/log' && req.method === 'DELETE') {
    requestLog.length = 0
    res.writeHead(204)
    res.end()
    return
  }

  // Register script (for dynamic test setup)
  if (url.pathname === '/mock/script' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req))
    // Simple pattern-based script: { pattern: "regex", response: "text" }
    addScript({
      match: (msg) => new RegExp(body.pattern, 'i').test(msg),
      respond: () => ({
        text: body.response ?? body.text,
        toolUse: body.toolUse,
        stopReason: body.toolUse ? 'tool_use' : 'end_turn'
      })
    })
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ registered: true }))
    return
  }

  // Clear scripts
  if (url.pathname === '/mock/scripts' && req.method === 'DELETE') {
    scripts.length = 0
    res.writeHead(204)
    res.end()
    return
  }

  // ── Messages API ──────────────────────────────────────────────────
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    const bodyStr = await readBody(req)
    let body: any
    try {
      body = JSON.parse(bodyStr)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }

    const model = body.model ?? 'claude-sonnet-4-20250514'
    const messages = body.messages ?? []
    const lastMsg = messages.filter((m: any) => m.role === 'user').pop()
    const lastUserText =
      typeof lastMsg?.content === 'string'
        ? lastMsg.content
        : Array.isArray(lastMsg?.content)
          ? lastMsg.content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('\n')
          : ''

    // Log the request
    requestLog.push({
      timestamp: Date.now(),
      model,
      messages,
      tools: body.tools,
      system: typeof body.system === 'string' ? body.system : undefined
    })

    if (VERBOSE) {
      console.log(`[mock-llm] ${req.method} ${url.pathname} model=${model} user="${lastUserText.slice(0, 80)}"`)
    }

    // Streaming response
    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      const plan = planResponse(lastUserText, messages, model)
      streamResponse(res, plan, model)
      res.end()
      return
    }

    // Non-streaming response (rare but handle it)
    const plan = planResponse(lastUserText, messages, model)
    const content: any[] = []
    if (plan.text) content.push({ type: 'text', text: plan.text })
    if (plan.toolUse) content.push({ type: 'tool_use', ...plan.toolUse })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: `msg_mock_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: plan.stopReason ?? 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: Math.ceil((plan.text?.length ?? 10) / 4) }
      })
    )
    return
  }

  // ── Models endpoint (SDK probes this) ─────────────────────────────
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', created_at: '2025-05-14' },
          { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', created_at: '2025-05-14' }
        ]
      })
    )
    return
  }

  // Catch-all
  if (VERBOSE) console.log(`[mock-llm] unhandled: ${req.method} ${url.pathname}`)
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-llm] listening on :${PORT}`)
})

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})
