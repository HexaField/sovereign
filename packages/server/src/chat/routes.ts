// Chat Module — REST + SSE endpoints

import { Router } from 'express'
import type { ChatModule } from './chat.js'
import type { AgentBackend } from '@sovereign/core'

export function createChatRoutes(chatModule: ChatModule, backend: AgentBackend): Router {
  const router = Router()

  router.get('/api/chat/status', (_req, res) => {
    res.json({ status: backend.status() })
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

  // ── SSE endpoint for per-thread event streaming ──────────────────
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

    // Send initial history
    const sessionKey = chatModule.resolveSessionKey(threadKey)
    try {
      const result = await backend.getHistory(sessionKey)
      send('history', { turns: result.turns, hasMore: result.hasMore })
    } catch {
      send('history', { turns: [], hasMore: false })
    }

    // Send current backend connection status
    send('backend-status', { status: backend.status() })

    // Send current queue state
    send('queue', { threadKey, queue: chatModule.getQueue(threadKey) })

    // Replay cached live state for in-progress work
    const live = chatModule.getLiveState(threadKey)
    if (live.status && live.status !== 'idle') {
      send('status', { status: live.status, threadKey })
      if (live.work?.length) {
        for (const item of live.work) {
          send('work', { work: item, threadKey })
        }
      }
      if (live.streamText) {
        send('stream', { text: live.streamText, threadKey, replay: true })
      }
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
