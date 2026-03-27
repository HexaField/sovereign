// Chat Module — WS proxy, session mapping, bus integration

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EventBus, ModuleStatus, AgentBackend, AgentBackendEvents, QueuedMessage } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'
import type { ThreadManager } from '../threads/types.js'
import { deriveSessionKey } from './derive-session-key.js'
import { createMessageQueue } from './message-queue.js'

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
}

export function createChatModule(
  bus: EventBus,
  backend: AgentBackend,
  threadManager: ThreadManager,
  options?: { dataDir?: string; wsHandler?: WsHandler }
): ChatModule {
  const dataDir = options?.dataDir ?? '.'
  const wsHandler = options?.wsHandler

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

  function broadcastQueueUpdate(threadKey: string): void {
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', {
        type: 'chat.queue.update',
        threadKey,
        queue: messageQueue.getQueue(threadKey)
      })
    }
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
          // When agent becomes idle, invalidate history cache so next load picks up
          // all messages (including those from context overflow resets, compaction, etc.)
          if (data.status === 'idle') {
            // cache removed
            tryProcessQueue(threadKey)
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

      // Emit bus event for chat.turn
      if (eventName === 'chat.turn' && threadKey) {
        bus.emit({
          type: 'chat.turn.completed',
          timestamp: new Date().toISOString(),
          source: 'chat',
          payload: { threadKey, turn: data.turn }
        })

        // Detect subagent spawns and auto-register them as threads
        const turn = data.turn as {
          workItems?: Array<{ type: string; name?: string; toolCallId?: string; input?: string; output?: string }>
        }
        if (turn?.workItems) {
          for (const w of turn.workItems) {
            if (w.type === 'tool_call' && w.name === 'sessions_spawn') {
              try {
                const input = typeof w.input === 'string' ? JSON.parse(w.input) : w.input
                const task = (input?.task || input?.message || '') as string
                const result = turn.workItems.find((r) => r.type === 'tool_result' && r.toolCallId === w.toolCallId)
                if (result?.output) {
                  const out = typeof result.output === 'string' ? JSON.parse(result.output) : result.output
                  const childKey = out?.childSessionKey as string | undefined
                  if (childKey) {
                    const parentThread = threadManager.get(threadKey)
                    threadManager.createIfNotExists({
                      key: childKey,
                      label: task.slice(0, 80) || childKey.split(':subagent:')[1]?.slice(0, 8) || 'Subagent',
                      orgId: parentThread?.orgId,
                      parentThreadKey: threadKey,
                      isSubagent: true
                    })
                  }
                }
              } catch {
                // Ignore parse errors — best-effort registration
              }
            }
          }
        }
      }
    })
  }

  // Also proxy backend.status
  backend.on('backend.status', (data) => {
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', {
        type: 'backend.status',
        ...data
      })
    }
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
    loadMapping
  }
}
