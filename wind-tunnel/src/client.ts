// SovereignClient — HTTP + WS test client for the wind tunnel.
//
// Wraps fetch + WebSocket with convenience methods for every
// Sovereign API surface. Timed operations record latency samples.

import WebSocket, { type RawData } from 'ws'

export interface Sample {
  name: string
  durationMs: number
  error?: string
}

export class SovereignClient {
  readonly baseUrl: string
  private ws: WebSocket | null = null
  private wsMessages: Array<{ channel: string; data: any }> = []
  private wsResolvers: Array<{
    channel: string
    type?: string
    resolve: (data: any) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  readonly samples: Sample[] = []

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  // ── HTTP helpers ──────────────────────────────────────────────────

  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`)
    if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  }

  async post<T = any>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`POST ${path} → ${res.status} ${res.statusText}: ${text}`)
    }
    return res.json() as Promise<T>
  }

  async patch<T = any>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined
    })
    if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${res.statusText}`)
    return res.json() as Promise<T>
  }

  async del(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) throw new Error(`DELETE ${path} → ${res.status}`)
  }

  /** Timed HTTP call — records latency as a sample. */
  async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      const result = await fn()
      this.samples.push({ name, durationMs: performance.now() - start })
      return result
    } catch (err: any) {
      this.samples.push({ name, durationMs: performance.now() - start, error: err?.message })
      throw err
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────

  async connectWs(channels: string[] = ['chat', 'threads']): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws'
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl)
      this.ws.on('open', () => {
        // Subscribe to channels
        this.ws!.send(JSON.stringify({ type: 'subscribe', channels }))
        resolve()
      })
      this.ws.on('message', (raw: RawData) => {
        try {
          const data = JSON.parse(raw.toString())
          this.wsMessages.push({ channel: data.channel ?? '', data })
          // Check waiting resolvers
          for (let i = this.wsResolvers.length - 1; i >= 0; i--) {
            const w = this.wsResolvers[i]
            if (data.type && (!w.type || w.type === data.type)) {
              clearTimeout(w.timer)
              w.resolve(data)
              this.wsResolvers.splice(i, 1)
            }
          }
        } catch {
          /* ignore non-json */
        }
      })
      this.ws.on('error', reject)
    })
  }

  /** Wait for a WS message matching the given type. Rejects after timeoutMs. */
  waitForWs(type: string, timeoutMs = 10000): Promise<any> {
    // Check buffered messages first
    const existing = this.wsMessages.find((m) => m.data.type === type)
    if (existing) {
      this.wsMessages.splice(this.wsMessages.indexOf(existing), 1)
      return Promise.resolve(existing.data)
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.wsResolvers.findIndex((w) => w.type === type)
        if (idx >= 0) this.wsResolvers.splice(idx, 1)
        reject(new Error(`WS timeout waiting for "${type}" after ${timeoutMs}ms`))
      }, timeoutMs)

      this.wsResolvers.push({ channel: '', type, resolve, reject, timer })
    })
  }

  /** Send a JSON message over the WS connection. */
  wsSend(data: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WS not connected')
    }
    this.ws.send(JSON.stringify(data))
  }

  /** Drain all buffered WS messages matching a type. */
  drainWs(type?: string): any[] {
    if (!type) {
      const all = [...this.wsMessages]
      this.wsMessages.length = 0
      return all.map((m) => m.data)
    }
    const matching = this.wsMessages.filter((m) => m.data.type === type)
    for (const m of matching) {
      this.wsMessages.splice(this.wsMessages.indexOf(m), 1)
    }
    return matching.map((m) => m.data)
  }

  disconnectWs(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.wsMessages.length = 0
    for (const w of this.wsResolvers) {
      clearTimeout(w.timer)
      w.reject(new Error('WS disconnected'))
    }
    this.wsResolvers.length = 0
  }

  // ── Sovereign API shortcuts ───────────────────────────────────────

  health(): Promise<{ status: string; message?: string }> {
    return this.get('/health')
  }

  async listThreads(opts?: { includeArchived?: boolean }): Promise<any[]> {
    const qs = opts?.includeArchived ? '' : '?active=true'
    const res = await this.get(`/api/threads${qs}`)
    return res?.threads ?? res ?? []
  }

  async createThread(opts: { label: string; membraneId?: string; presence?: string }): Promise<any> {
    const res = await this.post('/api/threads', opts)
    return res?.thread ?? res
  }

  deleteThread(id: string): Promise<void> {
    return this.del(`/api/threads/${id}`)
  }

  async getThread(id: string): Promise<any> {
    const res = await this.get(`/api/threads/${id}`)
    return res?.thread ?? res
  }

  async updateThread(id: string, patch: Record<string, unknown>): Promise<any> {
    const res = await this.patch(`/api/threads/${id}`, patch)
    return res?.thread ?? res
  }

  sendMessage(threadId: string, message: string, opts?: { origin?: any }): Promise<any> {
    return this.post('/api/chat/send', { threadId, message, ...opts })
  }

  /** Send a message with binary file attachments (base64-encoded). */
  sendMessageWithAttachments(
    threadId: string,
    message: string,
    attachments: Array<{ data: string; mediaType?: string }>
  ): Promise<any> {
    return this.post('/api/chat/send', {
      threadId,
      message,
      attachments: attachments.map((a) => a.data)
    })
  }

  chatStatus(): Promise<any> {
    return this.get('/api/chat/status')
  }

  threadHistory(threadId: string): Promise<any> {
    return this.get(`/api/threads/${threadId}/history`)
  }

  presenceThreads(): Promise<any> {
    return this.get('/api/threads/presence')
  }

  async listCrons(): Promise<any[]> {
    const res = await this.get('/api/crons')
    return res?.crons ?? res ?? []
  }

  listJobs(): Promise<any[]> {
    return this.get('/api/jobs')
  }

  createJob(body: any): Promise<any> {
    return this.post('/api/jobs', body)
  }

  deleteJob(id: string): Promise<void> {
    return this.del(`/api/jobs/${id}`)
  }

  systemHealth(): Promise<any> {
    return this.get('/api/system/health')
  }

  config(): Promise<any> {
    return this.get('/api/config')
  }

  async membranes(): Promise<any[]> {
    const res = await this.get('/api/membranes')
    return res?.membranes ?? res ?? []
  }
}
