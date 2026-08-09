#!/usr/bin/env -S npx tsx
// Mock LLM API — implements Anthropic /v1/messages AND OpenAI-compatible
// /v1/chat/completions, both with SSE streaming.
//
// Returns scripted responses keyed by scenario. The Claude Code SDK sends
// standard Anthropic message requests; the local-llm backend's inference
// client sends OpenAI chat-completion requests instead. Both formats share
// the same scripts registry (`planResponse`), so a single `/mock/script`
// call drives either caller — this server just speaks each provider's own
// wire protocol back (Anthropic SSE events vs OpenAI chat.completion.chunk).
//
// Environment:
//   PORT          — listen port (default 8900)
//   MOCK_VERBOSE  — set to "1" for request logging

import http from 'node:http'
import https from 'node:https'
import { execSync } from 'node:child_process'
import fs from 'node:fs'

const PORT = Number(process.env.PORT ?? 8900)
const TLS_PORT = Number(process.env.TLS_PORT ?? 443)
const VERBOSE = process.env.MOCK_VERBOSE === '1'

// ── Request log (for assertions) ────────────────────────────────────
interface LogEntry {
  timestamp: number
  model: string
  messages: unknown[]
  tools?: unknown[]
  system?: string
  /** Distinguishes Anthropic /v1/messages requests from OpenAI-compatible
   *  /v1/chat/completions requests, so scenarios can isolate local-llm
   *  traffic from Claude Code SDK traffic in the shared log. */
  format?: 'anthropic' | 'openai'
}
const requestLog: LogEntry[] = []

// ── Scripted response registry ──────────────────────────────────────
// Scripts are keyed by a matcher function over the last user message.
// First match wins. Default: echo the user message back.

interface Script {
  match: (lastUserMessage: string, messages: any[]) => boolean
  respond: (lastUserMessage: string, messages: any[], model: string) => ResponsePlan
  /** Fire at most once, then fall through (e.g. a tool_use that must not loop
   *  when the follow-up turn still carries the matching text in its history). */
  once?: boolean
  fired?: boolean
  /** Only fire on turns that actually offer tools. A tool_use reply is
   *  meaningless on the SDK's auxiliary, tool-less calls (title generation,
   *  structured-output probes) — and firing there would waste a `once` shot on
   *  a turn that ignores the tool_use. */
  needsTools?: boolean
}

interface ResponsePlan {
  text?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  stopReason?: 'end_turn' | 'tool_use'
  /** Hold the SSE stream open for this many ms before sending events. */
  delayMs?: number
}

const scripts: Script[] = []

/** Register a response script. First match wins. */
export function addScript(script: Script) {
  scripts.push(script)
}

function planResponse(userMsg: string, messages: any[], model: string, hasTools: boolean): ResponsePlan {
  for (const s of scripts) {
    if (s.once && s.fired) continue
    if (s.needsTools && !hasTools) continue
    if (s.match(userMsg, messages)) {
      s.fired = true
      return s.respond(userMsg, messages, model)
    }
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

// ── OpenAI-compatible helpers (local-llm backend) ───────────────────
// Mirrors the Anthropic SSE plumbing above, but speaks the OpenAI
// chat.completion.chunk wire format: bare `data: {...}` lines (no
// `event:` line) terminated by a literal `data: [DONE]`.

/** Flatten OpenAI message content — either a raw string, or an array of
 *  parts (text / image_url / etc.); text parts joined, others ignored. */
function openAiContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text as string)
      .join('\n')
  }
  return ''
}

/** Extract the last user message's text from an OpenAI `messages` array. */
function extractOpenAiLastUserText(messages: any[]): string {
  const lastMsg = messages.filter((m: any) => m?.role === 'user').pop()
  return lastMsg ? openAiContentText(lastMsg.content) : ''
}

/** OpenAI carries the system prompt as a `role: 'system'` message rather
 *  than Anthropic's top-level `system` field — extract it the same way so
 *  logged entries stay comparable across both formats. */
function extractOpenAiSystemText(messages: any[]): string | undefined {
  const sysMsg = messages.find((m: any) => m?.role === 'system')
  if (!sysMsg) return undefined
  const text = openAiContentText(sysMsg.content)
  return text || undefined
}

function sseDataWrite(res: http.ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function streamOpenAiResponse(res: http.ServerResponse, plan: ResponsePlan, model: string) {
  const chatId = `chatcmpl-mock-${Date.now()}`
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    sseDataWrite(res, {
      id: chatId,
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })

  // 1. Role-announcing first chunk.
  chunk({ role: 'assistant', content: '' })

  // 2. Tool call — one chunk announces id/name, a second carries the
  //    (already-complete) arguments string. Real providers may split
  //    arguments across many deltas; one shot is enough for the mock.
  if (plan.toolUse) {
    chunk({
      tool_calls: [
        { index: 0, id: plan.toolUse.id, type: 'function', function: { name: plan.toolUse.name, arguments: '' } }
      ]
    })
    chunk({
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(plan.toolUse.input) } }]
    })
  }

  // 3. Text content, streamed in fixed-size chunks for realism.
  if (plan.text) {
    const chunkSize = 20
    for (let i = 0; i < plan.text.length; i += chunkSize) {
      chunk({ content: plan.text.slice(i, i + chunkSize) })
    }
  }

  // 4. Final chunk carries finish_reason; [DONE] terminates the stream.
  chunk({}, plan.toolUse ? 'tool_calls' : 'stop')
  res.write('data: [DONE]\n\n')
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
  // Guard against prematurely-aborted requests (ECONNRESET from SDK
  // interrupt/abort). Track whether the *response* socket has gone away
  // — that's the only reliable signal the client disconnected early.
  // `req.on('close')` fires on every completed request in Node 22 and
  // must NOT set aborted unconditionally.
  let aborted = false
  res.on('close', () => {
    if (!res.writableFinished) aborted = true
  })
  req.on('error', () => {
    aborted = true
  })

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // Health
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', requests: requestLog.length }))
    return
  }

  // ── Claude CLI probe endpoints ──────────────────────────────────────
  // The claude binary sends HEAD/GET /api/hello to ANTHROPIC_BASE_URL as
  // a readiness check before making Messages API calls. A 404 here makes
  // the binary treat the API as unreachable and give up.
  if (url.pathname === '/api/hello') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(JSON.stringify({ status: 'ok' }))
    return
  }

  // OAuth / auth stubs — the claude CLI may probe these on startup.
  // Return minimal valid responses so the binary proceeds to API calls.
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'mock-token', token_type: 'bearer', expires_in: 86400 }))
    return
  }

  // Auth info / whoami stubs
  if (url.pathname === '/v1/organizations' || url.pathname === '/api/organizations') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
    return
  }

  // Settings / feature flags
  if (url.pathname.startsWith('/api/settings') || url.pathname.startsWith('/api/features')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({}))
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
  // Accepts: { pattern, response, toolUse, delayMs }
  if (url.pathname === '/mock/script' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req))
    addScript({
      match: (msg) => new RegExp(body.pattern, 'i').test(msg),
      respond: () => ({
        text: body.response ?? body.text,
        toolUse: body.toolUse,
        stopReason: body.toolUse ? 'tool_use' : 'end_turn',
        delayMs: body.delayMs
      }),
      once: body.once === true,
      // A tool_use reply makes most sense on a turn that offers tools.
      // Scenarios can override with explicit `needsTools: false` to force
      // the script to fire on the SDK's initial (tool-less) request — the
      // SDK's built-in tools (Bash, Read, etc.) execute regardless.
      needsTools: body.needsTools !== undefined ? !!body.needsTools : !!body.toolUse
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
    let bodyStr: string
    try {
      bodyStr = await readBody(req)
    } catch {
      // Client disconnected (ECONNRESET) — nothing to respond to.
      if (!res.headersSent) res.destroy()
      return
    }
    if (aborted) {
      if (!res.headersSent) res.destroy()
      return
    }

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
      system: typeof body.system === 'string' ? body.system : undefined,
      format: 'anthropic'
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

      const plan = planResponse(lastUserText, messages, model, Array.isArray(body.tools) && body.tools.length > 0)

      // Hold the stream open if the script requests a delay.
      // Bail early if the client disconnects (restart mid-stream).
      if (plan.delayMs && plan.delayMs > 0) {
        let aborted = false
        req.on('close', () => {
          aborted = true
        })
        await new Promise<void>((resolve) => setTimeout(resolve, plan.delayMs))
        if (aborted || res.destroyed) {
          res.end()
          return
        }
      }

      streamResponse(res, plan, model)
      res.end()
      return
    }

    // Non-streaming response (rare but handle it)
    const plan = planResponse(lastUserText, messages, model, Array.isArray(body.tools) && body.tools.length > 0)
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

  // ── OpenAI-compatible Chat Completions API (local-llm backend) ────
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let openAiBodyStr: string
    try {
      openAiBodyStr = await readBody(req)
    } catch {
      // Client disconnected (ECONNRESET) — nothing to respond to.
      if (!res.headersSent) res.destroy()
      return
    }
    if (aborted) {
      if (!res.headersSent) res.destroy()
      return
    }

    let openAiBody: any
    try {
      openAiBody = JSON.parse(openAiBodyStr)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json' }))
      return
    }

    const model = openAiBody.model ?? 'default'
    const messages = Array.isArray(openAiBody.messages) ? openAiBody.messages : []
    const lastUserText = extractOpenAiLastUserText(messages)
    const hasTools = Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0

    // Log the request
    requestLog.push({
      timestamp: Date.now(),
      model,
      messages,
      tools: openAiBody.tools,
      system: extractOpenAiSystemText(messages),
      format: 'openai'
    })

    if (VERBOSE) {
      console.log(`[mock-llm] ${req.method} ${url.pathname} model=${model} user="${lastUserText.slice(0, 80)}"`)
    }

    const plan = planResponse(lastUserText, messages, model, hasTools)

    // Streaming response
    if (openAiBody.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })

      // Hold the stream open if the script requests a delay. Bail early
      // if the client disconnects (restart mid-stream).
      if (plan.delayMs && plan.delayMs > 0) {
        let aborted = false
        req.on('close', () => {
          aborted = true
        })
        await new Promise<void>((resolve) => setTimeout(resolve, plan.delayMs))
        if (aborted || res.destroyed) {
          res.end()
          return
        }
      }

      streamOpenAiResponse(res, plan, model)
      res.end()
      return
    }

    // Non-streaming response
    const completionTokens = Math.ceil((plan.text?.length ?? 10) / 4)
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: plan.text ?? null
    }
    if (plan.toolUse) {
      message.tool_calls = [
        {
          id: plan.toolUse.id,
          type: 'function',
          function: { name: plan.toolUse.name, arguments: JSON.stringify(plan.toolUse.input) }
        }
      ]
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: plan.toolUse ? 'tool_calls' : 'stop'
          }
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: completionTokens,
          total_tokens: 10 + completionTokens
        }
      })
    )
    return
  }

  // ── Models endpoint (SDK + OpenAI-compatible clients probe this) ──
  if (url.pathname === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', created_at: '2025-05-14' },
          { id: 'claude-opus-4-20250514', display_name: 'Claude Opus 4', created_at: '2025-05-14' },
          { id: 'default', display_name: 'Mock Local Model', created_at: '2025-01-01' }
        ]
      })
    )
    return
  }

  // Catch-all — always log unhandled routes so we can discover what the
  // claude CLI probes on startup.
  console.log(`[mock-llm] unhandled: ${req.method} ${url.pathname}`)
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[mock-llm] listening on :${PORT} (HTTP)`)
})

// ── HTTPS listener for Claude CLI phone-home ────────────────────────
// The claude binary connects to api.anthropic.com:443 for auth/model
// discovery before making Messages API calls. By running an HTTPS
// server on port 443, the container's extra_hosts DNS override can
// route api.anthropic.com here instead of the real API. This lets the
// binary's startup handshake succeed with mock responses.
const CERT_DIR = '/tmp/mock-certs'
try {
  if (!fs.existsSync(`${CERT_DIR}/key.pem`)) {
    fs.mkdirSync(CERT_DIR, { recursive: true })
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${CERT_DIR}/key.pem ` +
        `-out ${CERT_DIR}/cert.pem -days 365 -nodes -subj '/CN=api.anthropic.com' 2>/dev/null`
    )
  }
  const tlsServer = https.createServer(
    { key: fs.readFileSync(`${CERT_DIR}/key.pem`), cert: fs.readFileSync(`${CERT_DIR}/cert.pem`) },
    server.listeners('request')[0] as http.RequestListener // reuse the same handler
  )
  tlsServer.listen(TLS_PORT, '0.0.0.0', () => {
    console.log(`[mock-llm] listening on :${TLS_PORT} (HTTPS — Claude CLI phone-home)`)
  })
  tlsServer.on('error', (err) => {
    console.warn(`[mock-llm] HTTPS listener failed (non-fatal): ${err.message}`)
  })
} catch (err: any) {
  console.warn(`[mock-llm] HTTPS setup skipped (openssl unavailable?): ${err.message}`)
}

process.on('unhandledRejection', (err) => {
  console.warn('[mock-llm] unhandled rejection (swallowed):', (err as Error)?.message ?? err)
})
process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})
