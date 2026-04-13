// Chat Module — REST + SSE endpoints

import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
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
    get(threadKey: string): string {
      return cache[threadKey] ?? ''
    },
    set(threadKey: string, text: string): void {
      if (text) {
        cache[threadKey] = text
      } else {
        delete cache[threadKey]
      }
      save()
    }
  }
}

export function createChatRoutes(chatModule: ChatModule, backend: AgentBackend, dataDir?: string): Router {
  const router = Router()
  const draftStore = createChatDraftStore(dataDir || process.env.SOVEREIGN_DATA_DIR || '.data')

  router.get('/api/chat/status', (_req, res) => {
    res.json({ status: backend.status() })
  })

  // ── Chat draft sync endpoints ──────────────────────────────────────
  router.get('/api/chat/draft', (req, res) => {
    const thread = req.query.thread as string
    if (!thread) return res.status(400).json({ error: 'thread query param required' })
    res.json({ text: draftStore.get(thread) })
  })

  router.put('/api/chat/draft', (req, res) => {
    const { threadKey, text } = req.body ?? {}
    if (!threadKey) return res.status(400).json({ error: 'threadKey required' })
    draftStore.set(threadKey, text ?? '')
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
      const { threadKey, message, attachments } = req.body ?? {}
      if (!threadKey || (!message && !attachments?.length)) {
        return res.status(400).json({ error: 'threadKey and message are required' })
      }
      // Convert base64 attachments to Buffers
      const buffers = attachments?.map((a: string) => Buffer.from(a, 'base64'))
      await chatModule.handleSend(threadKey, message || '', buffers)
      res.json({ success: true })
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

  router.get('/api/threads/:threadKey/history', async (req, res) => {
    const threadKey = req.params.threadKey
    const sessionKey = chatModule.resolveSessionKey(threadKey)

    // Check response cache first
    const cached = historyResponseCache.get(threadKey)
    if (cached && Date.now() - cached.timestamp < HISTORY_CACHE_TTL) {
      const json = JSON.stringify(cached.data)
      res.setHeader('Content-Type', 'application/json')
      return res.send(json)
    }

    try {
      const result = await backend.getHistory(sessionKey)
      const data = { turns: result.turns, hasMore: result.hasMore }
      historyResponseCache.set(threadKey, { data, timestamp: Date.now() })
      // Use res.send to avoid Content-Length mismatch with large payloads
      const json = JSON.stringify(data)
      res.setHeader('Content-Type', 'application/json')
      res.send(json)
    } catch {
      res.json({ turns: [], hasMore: false })
    }
  })

  // ── SSE endpoint for per-thread live event streaming ──────────────────
  router.get('/api/threads/:threadKey/events', async (req, res) => {
    const threadKey = req.params.threadKey
    const emitter = chatModule.chatEvents

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    // Helper to write SSE event
    function send(event: string, data: unknown): void {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        // Connection may be closed
      }
    }

    // Track this SSE client
    chatModule.trackSSEClient(threadKey)

    // Send lightweight initial state immediately (no blocking I/O)
    send('backend-status', { status: backend.status() })
    send('queue', { threadKey, queue: chatModule.getQueue(threadKey) })

    // Replay cached live state for in-progress work
    const live = chatModule.getLiveState(threadKey)
    let activeStatus = live.status
    if (!activeStatus || activeStatus === 'idle') {
      // Check gateway for real agent status — fire-and-forget, don't block SSE
      const backendAny = backend as any
      if (typeof backendAny.listGatewaySessions === 'function') {
        backendAny
          .listGatewaySessions()
          .then((sessions: any[]) => {
            const sessionKey = chatModule.resolveSessionKey(threadKey)
            const match = sessions.find((s: any) => s.key === sessionKey)
            if (match && match.agentStatus && match.agentStatus !== 'idle') {
              send('status', { status: match.agentStatus, threadKey })
              chatModule.ensurePolling(threadKey, match.agentStatus)
            }
          })
          .catch(() => {})
      }
    }
    if (activeStatus && activeStatus !== 'idle') {
      send('status', { status: activeStatus, threadKey })
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
          send('work', { work: item, threadKey })
        }
      }
      if (live.streamText) {
        send('stream', { text: live.streamText, threadKey, replay: true })
      }
      // Ensure the JSONL poll is running for this thread
      chatModule.ensurePolling(threadKey, activeStatus)
    }

    // Subscribe to chat-level events (includes backend events + JSONL-polled work)
    const handlers: Array<{ event: string; handler: (...args: any[]) => void }> = []

    function addHandler(event: string, fn: (data: Record<string, unknown>) => void): void {
      emitter.on(event, fn)
      handlers.push({ event, handler: fn })
    }

    function forThread(data: Record<string, unknown>): boolean {
      return data.threadKey === threadKey
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
        historyResponseCache.delete(threadKey) // invalidate cache on new turn
        send('turn', data)
      }
    })
    addHandler('chat.compacting', (data) => {
      if (forThread(data)) send('compacting', data)
    })
    addHandler('chat.error', (data) => {
      if (forThread(data)) send('error', data)
    })
    addHandler('chat.user-message', (data) => {
      if (forThread(data)) send('user-message', data)
    })
    addHandler('chat.queue.update', (data) => {
      if (forThread(data)) send('queue', data)
    })
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
      chatModule.untrackSSEClient(threadKey)
      for (const { event, handler } of handlers) {
        emitter.off(event, handler)
      }
    })
  })

  return router
}
