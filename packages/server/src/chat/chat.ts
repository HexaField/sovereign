// Chat Module — WS proxy, session mapping, bus integration

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type { EventBus, ModuleStatus, AgentBackend, AgentBackendEvents, QueuedMessage } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'
import type { ThreadManager } from '../threads/types.js'
import { deriveSessionKey } from './derive-session-key.js'
import { createMessageQueue } from './message-queue.js'
import { getSessionFilePath } from '../agent-backend/session-reader.js'
import type { WorkItem } from '@sovereign/core'

/** Chat-level event emitter — all chat events (from backend + JSONL polling) flow through here */
export type ChatEventHandler = (data: Record<string, unknown>) => void

export interface ChatModule {
  status(): ModuleStatus
  handleSend(threadKey: string, text: string, attachments?: Buffer[]): Promise<void>
  handleAbort(threadKey: string): Promise<void>
  handleHistory(threadKey: string, deviceId: string): Promise<void>
  handleFullHistory(threadKey: string, deviceId: string): Promise<void>
  handleSessionSwitch(threadKey: string): Promise<void>
  handleSessionCreate(label?: string): Promise<{ threadKey: string; sessionKey: string }>
  handleCancel(id: string): boolean
  getSessionKeyForThread(threadKey: string): string | undefined
  getThreadKeyForSession(sessionKey: string): string | undefined
  getQueue(threadKey: string): QueuedMessage[]
  loadMapping(): void
  /** Chat-level event emitter for SSE subscriptions. Events have threadKey resolved. */
  chatEvents: EventEmitter
  /** Get cached live state for a thread (for SSE replay on connect) */
  getLiveState(threadKey: string): { status?: string; work?: any[]; streamText?: string }
  /** Resolve a threadKey to a sessionKey, creating mapping if needed */
  resolveSessionKey(threadKey: string): string
}

export function createChatModule(
  bus: EventBus,
  backend: AgentBackend,
  threadManager: ThreadManager,
  options?: { dataDir?: string; wsHandler?: WsHandler }
): ChatModule {
  const dataDir = options?.dataDir ?? '.'
  const wsHandler = options?.wsHandler

  // Chat-level event emitter — SSE endpoint subscribes to this
  const chatEvents = new EventEmitter()
  chatEvents.setMaxListeners(100) // support many SSE connections

  // Bidirectional mapping: threadKey <-> sessionKey
  const threadToSession = new Map<string, string>()
  const sessionToThread = new Map<string, string>()

  const mappingPath = path.join(dataDir, 'chat', 'session-map.json')

  function persistMapping(): void {
    const dir = path.dirname(mappingPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const data = JSON.stringify(Object.fromEntries(threadToSession))
    const tmpPath = mappingPath + '.tmp'
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, mappingPath)
  }

  function loadMapping(): void {
    try {
      const data = fs.readFileSync(mappingPath, 'utf-8')
      const obj = JSON.parse(data) as Record<string, string>
      for (const [tk, sk] of Object.entries(obj)) {
        threadToSession.set(tk, sk)
        sessionToThread.set(sk, tk)
      }
    } catch {
      // No file or invalid — start empty
    }
  }

  // Load on creation
  loadMapping()

  // Message queue
  const messageQueue = createMessageQueue(dataDir)

  // Track when status last changed — for stuck-status recovery
  const statusChangedAt = new Map<string, number>()
  const STUCK_STATUS_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

  // Periodic check: if any thread has been "working" for too long, reset to idle
  setInterval(() => {
    const now = Date.now()
    for (const [threadKey, changedAt] of statusChangedAt) {
      const status = currentStatus.get(threadKey)
      if (status && status !== 'idle' && now - changedAt > STUCK_STATUS_TIMEOUT_MS) {
        console.log(
          `[chat] stuck status recovery: ${threadKey} was '${status}' for ${Math.round((now - changedAt) / 1000)}s, resetting to idle`
        )
        currentStatus.set(threadKey, 'idle')
        statusChangedAt.set(threadKey, now)
        stopJsonlPoll(threadKey)
        tryProcessQueue(threadKey)
        // Broadcast the status change to clients
        if (wsHandler) {
          wsHandler.broadcastToChannel('chat', { type: 'chat.status', threadKey, status: 'idle' })
        }
        chatEvents.emit('chat.status', { threadKey, status: 'idle' })
      }
    }
  }, 30_000) // Check every 30s

  function broadcastQueueUpdate(threadKey: string): void {
    const queueData = { threadKey, queue: messageQueue.getQueue(threadKey) }
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', { type: 'chat.queue.update', ...queueData })
    }
    chatEvents.emit('chat.queue.update', queueData)
  }

  function tryProcessQueue(threadKey: string): void {
    const status = currentStatus.get(threadKey)
    // Only process if agent is idle (or no status yet = idle)
    if (status && status !== 'idle') return
    if (backend.status() !== 'connected') return
    const next = messageQueue.peek(threadKey)
    if (!next) return
    // If the head item is still being sent (removeSent hasn't run yet),
    // schedule a retry — the idle event fired before the send promise resolved
    if (next.status === 'sending') {
      setTimeout(() => tryProcessQueue(threadKey), 200)
      return
    }
    messageQueue.markSending(next.id)
    broadcastQueueUpdate(threadKey)

    let sessionKey = threadToSession.get(threadKey)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadKey)
      setMapping(threadKey, sessionKey)
    }
    backend
      .sendMessage(sessionKey, next.text)
      .then(() => {
        messageQueue.removeSent(next.id)
        broadcastQueueUpdate(threadKey)
        // cache removed
        // After removing the sent item, try to process the next one.
        // tryProcessQueue checks currentStatus so it won't send while agent is busy.
        // This handles the case where idle fired while this item was still 'sending'.
        tryProcessQueue(threadKey)
      })
      .catch(() => {
        messageQueue.markQueued(next.id)
        broadcastQueueUpdate(threadKey)
      })
    bus.emit({
      type: 'chat.message.sent',
      timestamp: new Date().toISOString(),
      source: 'chat',
      payload: { threadKey, text: next.text, timestamp: Date.now() }
    })
  }

  function setMapping(threadKey: string, sessionKey: string): void {
    if (!threadKey || !sessionKey) return // Never store empty mappings
    threadToSession.set(threadKey, sessionKey)
    sessionToThread.set(sessionKey, threadKey)
    persistMapping()
  }

  // --- Live state cache for replay on reconnect ---
  const currentStatus = new Map<string, string>()
  const currentWork = new Map<string, any[]>()
  const currentStreamText = new Map<string, string>()

  // Proxy backend events to WS subscribers
  const backendEvents: (keyof AgentBackendEvents)[] = [
    'chat.stream',
    'chat.turn',
    'chat.status',
    'chat.work',
    'chat.compacting',
    'chat.error',
    'session.info'
  ]

  for (const eventName of backendEvents) {
    backend.on(eventName, (data: Record<string, unknown>) => {
      const sessionKey = data.sessionKey as string | undefined
      const threadKey = sessionKey ? sessionToThread.get(sessionKey) : undefined

      // Cache live state per thread for replay on reconnect
      if (threadKey) {
        if (eventName === 'chat.status') {
          currentStatus.set(threadKey, data.status as string)
          statusChangedAt.set(threadKey, Date.now())
          if (data.status === 'idle') {
            stopJsonlPoll(threadKey)
            tryProcessQueue(threadKey)
          } else if (data.status === 'working' || data.status === 'thinking') {
            // Start polling JSONL for tool calls since gateway WS doesn't stream them
            const sessionKey2 = threadToSession.get(threadKey) ?? deriveSessionKey(threadKey)
            startJsonlPoll(threadKey, sessionKey2)
          }
        } else if (eventName === 'chat.work') {
          const items = currentWork.get(threadKey) ?? []
          items.push(data.work)
          currentWork.set(threadKey, items)
        } else if (eventName === 'chat.stream') {
          const prev = currentStreamText.get(threadKey) ?? ''
          currentStreamText.set(threadKey, prev + (data.text as string))
        } else if (eventName === 'chat.turn') {
          // Turn complete — clear cached state and invalidate history cache
          currentStatus.delete(threadKey)
          statusChangedAt.delete(threadKey)
          currentWork.delete(threadKey)
          currentStreamText.delete(threadKey)
          // cache removed
        }
      }

      // Fallback: if idle event has no thread mapping, try all queues with pending items
      if (!threadKey && eventName === 'chat.status' && data.status === 'idle') {
        for (const [tk] of messageQueue.getAllQueues()) {
          tryProcessQueue(tk)
        }
      }

      // Map WS message type
      const wsType = eventName === 'session.info' ? 'chat.session.info' : eventName

      if (wsHandler && threadKey) {
        wsHandler.broadcastToChannel('chat', {
          type: wsType,
          ...data,
          threadKey
        })
      }

      // Emit on chat-level emitter for SSE subscribers
      if (threadKey) {
        chatEvents.emit(wsType, { ...data, threadKey })
      }

      // Emit bus event for chat.turn
      if (eventName === 'chat.turn' && threadKey) {
        bus.emit({
          type: 'chat.turn.completed',
          timestamp: new Date().toISOString(),
          source: 'chat',
          payload: { threadKey, turn: data.turn }
        })
      }
    })
  }

  // ── JSONL polling for live tool calls ──────────────────────────────
  // The gateway WS doesn't stream tool_call/tool_result events.
  // Poll the JSONL file every 2s while the agent is working to pick up new tool calls.
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  const pollFilePositions = new Map<string, number>() // track file read position
  const pollSeenToolIds = new Map<string, Set<string>>()

  function startJsonlPoll(threadKey: string, sessionKey: string): void {
    if (pollTimers.has(threadKey)) return // already polling

    const filePath = getSessionFilePath(sessionKey)

    // Start from current file size (only read NEW entries)
    try {
      const stat = fs.statSync(filePath)
      pollFilePositions.set(threadKey, stat.size)
    } catch {
      return
    }
    pollSeenToolIds.set(threadKey, new Set())

    const timer = setInterval(() => {
      try {
        const stat = fs.statSync(filePath)
        const lastPos = pollFilePositions.get(threadKey) ?? 0
        if (stat.size <= lastPos) return // no new data

        // Read only the new portion
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(stat.size - lastPos)
        fs.readSync(fd, buf, 0, buf.length, lastPos)
        fs.closeSync(fd)
        pollFilePositions.set(threadKey, stat.size)

        const newText = buf.toString('utf-8')
        const lines = newText.split('\n').filter(Boolean)
        const seen = pollSeenToolIds.get(threadKey)!

        let latestThinking: { text: string; timestamp: number } | null = null
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            if (entry.type !== 'message') continue
            const msg = entry.message
            if (!msg) continue
            const content = msg.content
            if (!Array.isArray(content)) continue

            for (const block of content) {
              // Extract thinking/reasoning text from assistant messages with tool calls
              // Only emit as thinking if this message also has tool calls
              if (block.type === 'text' && block.text && msg.role === 'assistant') {
                const hasToolCalls = content.some((b: any) => b.type === 'toolCall' || b.type === 'tool_use')
                if (hasToolCalls && block.text.trim()) {
                  // Track latest thinking per poll cycle - will emit after processing all lines
                  latestThinking = { text: block.text.trim(), timestamp: Date.now() }
                }
              }

              if (block.type === 'toolCall' || block.type === 'tool_use') {
                const id = block.id || ''
                if (id && seen.has(id)) continue
                seen.add(id)
                const input = block.arguments ?? block.input ?? {}
                const inputStr = typeof input === 'string' ? input : JSON.stringify(input)
                const work: WorkItem = {
                  type: 'tool_call',
                  name: block.name || 'tool',
                  input: inputStr,
                  toolCallId: id,
                  timestamp: Date.now()
                }
                // Emit to clients
                if (wsHandler) {
                  wsHandler.broadcastToChannel('chat', { type: 'chat.work', threadKey, work })
                }
                chatEvents.emit('chat.work', { threadKey, work })
                const items = currentWork.get(threadKey) ?? []
                items.push(work)
                currentWork.set(threadKey, items)
              }
            }

            // Also check for toolResult messages
            if (msg.role === 'toolResult') {
              const tcId = msg.toolCallId || ''
              const resultKey = `result:${tcId}`
              if (tcId && !seen.has(resultKey)) {
                seen.add(resultKey)
                const output = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '')
                const work: WorkItem = {
                  type: 'tool_result',
                  name: msg.name,
                  output,
                  toolCallId: tcId,
                  timestamp: Date.now()
                }
                if (wsHandler) {
                  wsHandler.broadcastToChannel('chat', { type: 'chat.work', threadKey, work })
                }
                chatEvents.emit('chat.work', { threadKey, work })
                const items = currentWork.get(threadKey) ?? []
                items.push(work)
                currentWork.set(threadKey, items)
              }
            }
          } catch {
            /* skip malformed lines */
          }
        }

        // Emit latest thinking from this poll cycle (single event, not per-message)
        if (latestThinking) {
          const work: WorkItem = {
            type: 'thinking',
            output: latestThinking.text,
            timestamp: latestThinking.timestamp
          }
          if (wsHandler) {
            wsHandler.broadcastToChannel('chat', { type: 'chat.work', threadKey, work })
          }
          chatEvents.emit('chat.work', { threadKey, work })
          const items = currentWork.get(threadKey) ?? []
          items.push(work)
          currentWork.set(threadKey, items)
        }
      } catch {
        /* file read error — ignore */
      }
    }, 2000)

    pollTimers.set(threadKey, timer)
  }

  function stopJsonlPoll(threadKey: string): void {
    const timer = pollTimers.get(threadKey)
    if (timer) {
      clearInterval(timer)
      pollTimers.delete(threadKey)
    }
    pollFilePositions.delete(threadKey)
    pollSeenToolIds.delete(threadKey)
  }

  // Also proxy backend.status
  backend.on('backend.status', (data) => {
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', {
        type: 'backend.status',
        ...data
      })
    }
    chatEvents.emit('backend.status', data)
  })

  // deriveSessionKey is imported at module level from ./derive-session-key.js

  async function handleSend(threadKey: string, text: string, _attachments?: Buffer[]): Promise<void> {
    if (!threadKey) return // No thread — don't send
    // Enqueue the message — server owns the queue
    messageQueue.enqueue(threadKey, text)
    broadcastQueueUpdate(threadKey)

    // Broadcast the user message to all connected clients on this thread
    // so other tabs/devices see it in real-time without refresh
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', {
        type: 'chat.user-message',
        threadKey,
        text,
        timestamp: new Date().toISOString()
      })
    }
    chatEvents.emit('chat.user-message', { threadKey, text, timestamp: new Date().toISOString() })

    tryProcessQueue(threadKey)
  }

  async function handleAbort(threadKey: string): Promise<void> {
    const sessionKey = threadToSession.get(threadKey)
    if (sessionKey) {
      await backend.abort(sessionKey)
    }
  }

  async function handleHistory(threadKey: string, deviceId: string): Promise<void> {
    if (!threadKey) return // No thread selected — nothing to fetch
    const t0 = Date.now()
    let sessionKey = threadToSession.get(threadKey)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadKey)
      setMapping(threadKey, sessionKey)
    }

    // Always fetch fresh history from the backend
    let history: any[]
    let hasMore = false
    try {
      const result = await backend.getHistory(sessionKey)
      history = result.turns
      hasMore = result.hasMore
    } catch {
      history = []
    }

    const elapsed = Date.now() - t0
    if (elapsed > 50) console.log(`[chat] history fetch ${threadKey}: ${elapsed}ms, ${history.length} turns`)
    if (wsHandler) {
      wsHandler.sendTo(deviceId, { type: 'chat.session.info', threadKey, sessionKey, history, hasMore })

      // Send current backend connection status so the client indicator is accurate
      wsHandler.sendTo(deviceId, { type: 'backend.status', status: backend.status() })

      // Replay cached live state so reconnecting clients see in-progress work
      const status = currentStatus.get(threadKey)
      if (status && status !== 'idle') {
        wsHandler.sendTo(deviceId, { type: 'chat.status', threadKey, status })
        const work = currentWork.get(threadKey)
        if (work?.length) {
          for (const item of work) {
            wsHandler.sendTo(deviceId, { type: 'chat.work', threadKey, work: item })
          }
        }
        const text = currentStreamText.get(threadKey)
        if (text) {
          wsHandler.sendTo(deviceId, { type: 'chat.stream', threadKey, text, replay: true })
        }
      }

      // Send current queue state
      wsHandler.sendTo(deviceId, {
        type: 'chat.queue.update',
        threadKey,
        queue: messageQueue.getQueue(threadKey)
      })
    }
  }

  async function handleSessionSwitch(threadKey: string): Promise<void> {
    const sessionKey = threadToSession.get(threadKey)
    if (sessionKey) {
      await backend.switchSession(sessionKey)
    }
  }

  async function handleFullHistory(threadKey: string, deviceId: string): Promise<void> {
    if (!threadKey) return
    let sessionKey = threadToSession.get(threadKey)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadKey)
      setMapping(threadKey, sessionKey)
    }

    try {
      // Full history via gateway RPC or direct file read — slower but complete
      const history = await backend.getFullHistory(sessionKey)
      // cache removed
      if (wsHandler) {
        wsHandler.sendTo(deviceId, { type: 'chat.session.info', threadKey, sessionKey, history, hasMore: false })
      }
    } catch {
      // Silently fail — client already has partial history
    }
  }

  function handleCancel(id: string): boolean {
    // Find the threadKey before cancelling (item will be removed)
    let targetThreadKey: string | undefined
    for (const [threadKey, items] of messageQueue.getAllQueues()) {
      if (items.some((m) => m.id === id)) {
        targetThreadKey = threadKey
        break
      }
    }
    const cancelled = messageQueue.cancel(id)
    if (cancelled && targetThreadKey) {
      broadcastQueueUpdate(targetThreadKey)
    }
    return cancelled
  }

  async function handleSessionCreate(label?: string): Promise<{ threadKey: string; sessionKey: string }> {
    const thread = threadManager.create({ label })
    const sessionKey = deriveSessionKey(thread.key)
    setMapping(thread.key, sessionKey)
    return { threadKey: thread.key, sessionKey }
  }

  return {
    status: () => ({ name: 'chat', status: 'ok' }),
    handleSend,
    handleAbort,
    handleHistory,
    handleFullHistory,
    handleSessionSwitch,
    handleSessionCreate,
    handleCancel,
    getSessionKeyForThread: (tk: string) => threadToSession.get(tk),
    getThreadKeyForSession: (sk: string) => sessionToThread.get(sk),
    getQueue: (threadKey: string) => messageQueue.getQueue(threadKey),
    loadMapping,
    chatEvents,
    getLiveState: (threadKey: string) => ({
      status: currentStatus.get(threadKey),
      work: currentWork.get(threadKey),
      streamText: currentStreamText.get(threadKey)
    }),
    resolveSessionKey: (threadKey: string) => {
      let sk = threadToSession.get(threadKey)
      if (!sk) {
        sk = deriveSessionKey(threadKey)
        setMapping(threadKey, sk)
      }
      return sk
    }
  }
}
