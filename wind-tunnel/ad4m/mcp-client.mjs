// Minimal MCP client for the AD4M executor's streamable-HTTP transport.
//
// Speaks JSON-RPC 2.0 over HTTP POST; the executor answers as text/event-stream
// (SSE) and tracks the session via the Mcp-Session-Id header. Auth rides a
// Bearer token (the admin credential or a user JWT). Plain .mjs so both the
// docker provision step (node) and the s10 scenario (tsx) can use it.

export class McpClient {
  #sessionId = null
  #nextId = 1

  constructor(baseUrl, token) {
    this.baseUrl = baseUrl
    this.token = token
  }

  setToken(token) {
    this.token = token
  }

  #headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    if (this.#sessionId) h['Mcp-Session-Id'] = this.#sessionId
    return h
  }

  async #rpc(method, params, timeoutMs = 20000) {
    const id = this.#nextId++
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ctrl.signal
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) this.#sessionId = sid
      const ctype = res.headers.get('content-type') || ''
      if (ctype.includes('text/event-stream')) return await this.#readSseForId(res, id, timeoutMs)
      const json = await res.json()
      if (json.error) throw new Error(`MCP ${method} error: ${JSON.stringify(json.error)}`)
      return json.result
    } finally {
      clearTimeout(timer)
    }
  }

  async #readSseForId(res, id, timeoutMs) {
    if (!res.body) throw new Error('MCP: empty response body')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let sep
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          for (const line of frame.split('\n')) {
            const m = line.match(/^data:\s?(.*)$/)
            if (!m || !m[1]) continue
            let msg
            try {
              msg = JSON.parse(m[1])
            } catch {
              continue
            }
            if (msg.id === id) {
              if (msg.error) throw new Error(`MCP error: ${JSON.stringify(msg.error)}`)
              return msg.result
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        /* stream already closed */
      }
    }
    throw new Error(`MCP: no response for id ${id} within ${timeoutMs}ms`)
  }

  async #notify(method, params) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
        signal: ctrl.signal
      }).catch(() => {})
    } finally {
      clearTimeout(timer)
    }
  }

  async initialize(clientName = 'sovereign-wind-tunnel', version = '0.1.0') {
    const result = await this.#rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version }
    })
    await this.#notify('notifications/initialized', {})
    return result
  }

  async callTool(name, args = {}) {
    return await this.#rpc('tools/call', { name, arguments: args })
  }

  async callToolJson(name, args = {}) {
    const r = await this.callTool(name, args)
    const text = r?.content?.find((c) => c.type === 'text')?.text
    if (text == null) return r
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

/** Pick the first string value under any of the given keys (or a bare string). */
export function pick(o, ...keys) {
  if (typeof o === 'string') return o
  for (const k of keys) if (o && typeof o[k] === 'string') return o[k]
  return ''
}
