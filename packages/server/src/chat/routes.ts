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

  router.post('/api/chat/send', async (req, res) => {
    try {
      const { threadKey, message } = req.body ?? {}
      if (!threadKey || !message) {
        return res.status(400).json({ error: 'threadKey and message are required' })
      }
      await chatModule.handleSend(threadKey, message)
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
  router.get('/api/threads/:threadKey/history', async (req, res) => {
    const threadKey = req.params.threadKey
    const sessionKey = chatModule.resolveSessionKey(threadKey)
    try {
      const result = await backend.getHistory(sessionKey)
      res.json({ turns: result.turns, hasMore: result.hasMore })
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

    // Send lightweight initial state immediately (no blocking I/O)
    send('backend-status', { status: backend.status() })
    send('queue', { threadKey, queue: chatModule.getQueue(threadKey) })

    // Replay cached live state for in-progress work
    const live = chatModule.getLiveState(threadKey)
    let activeStatus = live.status
    if (!activeStatus || activeStatus === 'idle') {
      // Check gateway for real agent status — fire-and-forget, don't block SSE
      backend
        .listGatewaySessions()
        .then((sessions) => {
          const sessionKey = chatModule.resolveSessionKey(threadKey)
          const match = sessions.find((s: any) => s.key === sessionKey)
          if (match && match.agentStatus && match.agentStatus !== 'idle') {
            send('status', { status: match.agentStatus, threadKey })
            chatModule.ensurePolling(threadKey, match.agentStatus)
          }
        })
        .catch(() => {})
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
      if (forThread(data)) send('turn', data)
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
      for (const { event, handler } of handlers) {
        emitter.off(event, handler)
      }
    })
  })

  return router
}
