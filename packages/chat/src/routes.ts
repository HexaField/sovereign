// Chat Module — REST + SSE endpoints

import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ChatModule } from './chat.js'
import type { AgentBackend } from '@sovereign/core'

/** Simple file-backed draft store for chat input drafts (syncs across devices). */
function createChatDraftStore(dataDir: string) {
  const filePath = path.join(dataDir, 'chat-drafts.json')
  let cache: Record<string, string> = {}

  // Load from disk
  try {
    if (fs.existsSync(filePath)) {
      cache = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    }
  } catch {
    cache = {}
  }

  function save(): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(cache), 'utf-8')
    } catch {
      /* ignore */
    }
  }

  return {
    get(threadId: string): string {
      return cache[threadId] ?? ''
    },
    set(threadId: string, text: string): void {
      if (text) {
        cache[threadId] = text
      } else {
        delete cache[threadId]
      }
      save()
    }
  }
}

export interface ChatRoutesOptions {
  /** Base URL of the llama-server (e.g. http://127.0.0.1:9090).
   *  When provided, GET /api/llm/slots is exposed as a thin proxy so the
   *  client can poll prefill progress without knowing the internal URL. */
  llamaBaseUrl?: string
}

export function createChatRoutes(
  chatModule: ChatModule,
  backend: AgentBackend,
  dataDir: string,
  opts?: ChatRoutesOptions
): Router {
  const router = Router()
  const draftStore = createChatDraftStore(dataDir)

  router.get('/api/chat/status', (_req, res) => {
    res.json({ status: backend.status() })
  })

  // ── LLM slot status — proxied from llama-server for prefill progress ──
  // Returns raw /slots response from llama-server so the client can compute
  // prefill % without needing to know the internal llama-server URL.
  // Returns 503 when llamaBaseUrl is not configured or the server is down.
  router.get('/api/llm/slots', async (_req, res) => {
    const base = opts?.llamaBaseUrl
    if (!base) {
      res.status(503).json({ error: 'llm endpoint not configured' })
      return
    }
    try {
      const r = await fetch(`${base}/slots`)
      if (!r.ok) {
        res.status(r.status).json({ error: 'upstream error' })
        return
      }
      const data = await r.json()
      res.json(data)
    } catch {
      res.status(503).json({ error: 'llm unreachable' })
    }
  })

  // Context budget for a thread — resolves threadId → sessionKey, then
  // delegates to backend.getContextBudget(). Used by the wind tunnel's
  // s12-session-recycle scenario and the UI context bar.
  router.get('/api/chat/context-budget', async (req, res) => {
    const threadId = (req.query.threadId as string) ?? ''
    if (!threadId) return res.status(400).json({ error: 'threadId query param required' })
    const sessionKey = chatModule.getSessionKeyForThread(threadId) ?? threadId
    try {
      const budget = await backend.getContextBudget(sessionKey)
      res.json(budget ?? { tokens: 0 })
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'context budget unavailable' })
    }
  })

  // ── Chat draft sync endpoints ──────────────────────────────────────
  router.get('/api/chat/draft', (req, res) => {
    const thread = req.query.thread as string
    if (!thread) return res.status(400).json({ error: 'thread query param required' })
    res.json({ text: draftStore.get(thread) })
  })

  router.put('/api/chat/draft', (req, res) => {
    const { threadId, text } = req.body ?? {}
    if (!threadId) return res.status(400).json({ error: 'threadId required' })
    draftStore.set(threadId, text ?? '')
    res.json({ ok: true })
  })

  // ── File upload endpoint ──
  router.post('/api/chat/upload', async (req, res) => {
    try {
      // Accept multipart form data with files
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      await new Promise<void>((resolve) => req.on('end', resolve))
      const body = Buffer.concat(chunks)

      // Parse multipart boundary
      const contentType = req.headers['content-type'] || ''
      const boundaryMatch = contentType.match(/boundary=(.+)/)
      if (!boundaryMatch) {
        // Fallback: treat entire body as single file upload with base64 encoding
        const { name, data } = JSON.parse(body.toString('utf-8'))
        return res.json({ files: [{ name, data }] })
      }

      // For now, accept JSON with base64-encoded files
      return res.status(400).json({ error: 'Use JSON upload with base64 data' })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/api/chat/send', async (req, res) => {
    try {
      const { threadId, message, attachments, origin, immediate } = req.body ?? {}
      if (!threadId || (!message && !attachments?.length)) {
        return res.status(400).json({ error: 'threadId and message are required' })
      }
      // Convert attachment payloads to Attachment objects.
      // Accepts both the new { name, mediaType, data } format and legacy
      // bare base64 strings for backward compatibility.
      const parsed = attachments?.map((a: string | { name?: string; mediaType?: string; data: string }) => {
        if (typeof a === 'string') {
          return { name: 'attachment', mediaType: 'application/octet-stream', data: Buffer.from(a, 'base64') }
        }
        return {
          name: a.name || 'attachment',
          mediaType: a.mediaType || 'application/octet-stream',
          data: Buffer.from(a.data, 'base64')
        }
      })
      const opts: Record<string, unknown> = {}
      if (origin) opts.origin = origin
      if (immediate) opts.immediate = true
      await chatModule.handleSend(threadId, message || '', parsed, Object.keys(opts).length > 0 ? opts : undefined)
      // Return current queue snapshot so HTTP-only clients have a fresh view
      // without waiting for the SSE round-trip.
      res.json({ success: true, queue: chatModule.getQueueSnapshot(threadId) })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Outbound queue endpoints ─────────────────────────────────────
  router.get('/api/threads/:threadId/queue', (req, res) => {
    res.json({ items: chatModule.getQueueSnapshot(req.params.threadId) })
  })

  router.delete('/api/chat/queue/:id', (req, res) => {
    const ok = chatModule.cancelQueued(req.params.id)
    if (!ok) return res.status(404).json({ error: 'not cancellable (missing or in-flight)' })
    res.json({ ok: true })
  })

  router.post('/api/chat/queue/:id/retry', (req, res) => {
    const ok = chatModule.retryQueued(req.params.id)
    if (!ok) return res.status(404).json({ error: 'not retriable' })
    res.json({ ok: true })
  })

  router.post('/api/chat/queue/:id/force-send', async (req, res) => {
    try {
      const ok = await chatModule.forceSend(req.params.id)
      if (!ok) return res.status(404).json({ error: 'not force-sendable (missing or already sending)' })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  router.post('/api/chat/sessions', async (_req, res) => {
    try {
      const label = _req.body?.label as string | undefined
      const result = await chatModule.handleSessionCreate(label)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── HTTP endpoint for thread history (fast, independent of SSE) ──
  // Cache for history responses (short TTL to avoid re-parsing 3MB JSONL on every request)
  const historyResponseCache = new Map<string, { data: any; timestamp: number }>()
  const HISTORY_CACHE_TTL = 5000 // 5s — fresh enough for human perception, avoids constant re-parse

  // Periodic cleanup of stale cache entries (prevent unbounded growth)
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of historyResponseCache) {
      if (now - entry.timestamp > HISTORY_CACHE_TTL * 6) {
        // 30s expiry
        historyResponseCache.delete(key)
      }
    }
  }, 30_000)

  router.get('/api/threads/:threadId/history', async (req, res) => {
    const threadId = req.params.threadId
    const sessionKey = chatModule.resolveSessionKey(threadId)
    const before = req.query.before ? Number(req.query.before) : undefined
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    const paginationOpts = before || limit ? { before, limit } : undefined

    // Only use cache for initial loads (no cursor) — paginated requests bypass
    if (!paginationOpts) {
      const cached = historyResponseCache.get(threadId)
      if (cached && Date.now() - cached.timestamp < HISTORY_CACHE_TTL) {
        const json = JSON.stringify(cached.data)
        const etag = `"${crypto.createHash('md5').update(json).digest('hex')}"`
        if (req.headers['if-none-match'] === etag) {
          return res.status(304).end()
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('ETag', etag)
        return res.send(json)
      }
    }

    try {
      const result = await backend.getHistory(sessionKey, paginationOpts)
      const data = { turns: result.turns, hasMore: result.hasMore, oldestTimestamp: result.oldestTimestamp }

      // Cache only non-paginated initial loads
      if (!paginationOpts) {
        historyResponseCache.set(threadId, { data, timestamp: Date.now() })
      }
      const json = JSON.stringify(data)
      const etag = `"${crypto.createHash('md5').update(json).digest('hex')}"`
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end()
      }
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('ETag', etag)
      res.send(json)
    } catch {
      res.json({ turns: [], hasMore: false })
    }
  })

  // ── Archived (pre-compaction) history ─────────────────────────────────
  router.get('/api/threads/:threadId/history/archived', async (req, res) => {
    const threadId = req.params.threadId
    const sessionKey = chatModule.resolveSessionKey(threadId)
    const before = req.query.before ? Number(req.query.before) : undefined
    const limit = req.query.limit ? Number(req.query.limit) : undefined
    const paginationOpts = before || limit ? { before, limit } : undefined
    try {
      if (typeof backend.getArchivedHistory !== 'function') {
        return res.json({ turns: [], hasMore: false, archiveCount: 0 })
      }
      const result = await backend.getArchivedHistory(sessionKey, paginationOpts)
      res.json(result)
    } catch {
      res.json({ turns: [], hasMore: false, archiveCount: 0 })
    }
  })

  // ── SSE endpoint for per-thread live event streaming ──────────────────
  router.get('/api/threads/:threadId/events', async (req, res) => {
    const threadId = req.params.threadId
    const emitter = chatModule.chatEvents

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    // SSE sequence counter for this connection
    let seq = 0

    // Helper to write SSE event with sequence ID
    function send(event: string, data: unknown): void {
      try {
        seq++
        res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Connection may be closed
      }
    }

    // Track this SSE client
    chatModule.trackSSEClient(threadId)

    // Send lightweight initial state immediately (no blocking I/O)
    send('backend-status', { status: backend.status() })

    // Always send the current queue snapshot on connect so the client can
    // render queued/sending/failed items without a separate REST round-trip.
    send('queue', { threadId, items: chatModule.getQueueSnapshot(threadId) })

    // Replay cached live state for in-progress work
    const live = chatModule.getLiveState(threadId)
    let activeStatus = live.status
    if (!activeStatus || activeStatus === 'idle') {
      // Check gateway for real agent status — fire-and-forget, don't block SSE
      const backendAny = backend as any
      if (typeof backendAny.listGatewaySessions === 'function') {
        backendAny
          .listGatewaySessions()
          .then((sessions: any[]) => {
            const sessionKey = chatModule.resolveSessionKey(threadId)
            const match = sessions.find((s: any) => s.key === sessionKey)
            if (match && match.agentStatus && match.agentStatus !== 'idle') {
              send('status', { status: match.agentStatus, threadId })
              chatModule.ensurePolling(threadId, match.agentStatus)
            }
          })
          .catch(() => {})
      }
    }
    if (activeStatus && activeStatus !== 'idle') {
      send('status', { status: activeStatus, threadId })
      if (live.work?.length) {
        // Only replay the latest thinking item (not all accumulated ones)
        let lastThinkingIdx = -1
        for (let i = live.work.length - 1; i >= 0; i--) {
          if (live.work[i].type === 'thinking') {
            if (lastThinkingIdx === -1) lastThinkingIdx = i
          }
        }
        for (let i = 0; i < live.work.length; i++) {
          const item = live.work[i]
          // Skip all thinking items except the latest
          if (item.type === 'thinking' && i !== lastThinkingIdx) continue
          send('work', { work: item, threadId })
        }
      }
      if (live.streamText) {
        send('stream', { text: live.streamText, threadId, replay: true })
      }
      // Ensure the JSONL poll is running for this thread
      chatModule.ensurePolling(threadId, activeStatus)
    }
    // Replay the last error even when status is idle — the error persists until
    // the agent successfully completes a new turn, so a page reload must still
    // show it even if the thread has returned to idle after the failure.
    if (live.lastError) {
      send('error', { error: live.lastError, threadId, replay: true })
    }

    // Subscribe to chat-level events (includes backend events + JSONL-polled work)
    const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = []

    function addHandler(event: string, fn: (data: Record<string, unknown>) => void): void {
      emitter.on(event, fn)
      handlers.push({ event, handler: fn })
    }

    function forThread(data: Record<string, unknown>): boolean {
      return data.threadId === threadId
    }

    addHandler('chat.status', (data) => {
      if (forThread(data)) send('status', data)
    })
    addHandler('chat.stream', (data) => {
      if (forThread(data)) send('stream', data)
    })
    addHandler('chat.work', (data) => {
      if (forThread(data)) send('work', data)
    })
    addHandler('chat.turn', (data) => {
      if (forThread(data)) {
        historyResponseCache.delete(threadId) // invalidate cache on new turn
        send('turn', data)
      }
    })
    addHandler('chat.message.sent', (data) => {
      if (forThread(data)) {
        historyResponseCache.delete(threadId) // invalidate cache when a send is accepted
      }
    })
    addHandler('chat.compacting', (data) => {
      if (forThread(data)) send('compacting', data)
    })
    addHandler('chat.error', (data) => {
      if (forThread(data)) send('error', data)
    })
    addHandler('chat.queue', (data) => {
      if (forThread(data)) send('queue', data)
    })
    // chat.user-message handler removed — user turns come from history (single source of truth)
    addHandler('backend.status', (data) => {
      send('backend-status', data)
    })

    // Keep-alive ping every 30s
    const pingTimer = setInterval(() => {
      try {
        res.write(': keepalive\n\n')
      } catch {
        // Connection closed
      }
    }, 30000)

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(pingTimer)
      chatModule.untrackSSEClient(threadId)
      for (const { event, handler } of handlers) {
        emitter.off(event, handler)
      }
    })
  })

  return router
}
