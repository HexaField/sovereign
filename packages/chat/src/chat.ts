// Chat Module — WS proxy, session mapping, bus integration

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  EventBus,
  ModuleStatus,
  AgentBackend,
  AgentBackendEvents,
  QueuedMessage,
  MessageOrigin
} from '@sovereign/core'
import { renderOriginTag } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'
import { createWriteThroughStore, type WriteThroughStore } from '@sovereign/primitives'
import type { ThreadManager } from '@sovereign/threads'
import { deriveSessionKey } from './derive-session-key.js'
import { createMessageQueue, type MessageQueue } from './message-queue.js'
import type { WorkItem } from '@sovereign/core'

/** Minimal subset of @sovereign/agent-backend ActiveSessions used by chat,
 * defined here so chat doesn't depend on agent-backend. The full interface
 * is structurally compatible. */
export interface ChatActiveSessionsHook {
  setInFlight(sessionKey: string, info: { queueId: string; promptText: string }): void
}

/** Presence integration hook. The chat module calls into this just before
 *  delivering an inbound user message to the presence thread; the presence
 *  module returns its accumulated watched-thread digest (or null) and
 *  clears its buffer atomically. Optional — wired by bootstrap when the
 *  presence package is enabled. See plans/presence-thread-spec.md (R6). */
export interface ChatPresenceHook {
  /** Returns the accumulated digest as a single block of text ready to be
   *  prepended to the user message. Clears the buffer after returning.
   *  Return null/undefined when there's nothing to deliver. */
  takeDigest?(): string | null | undefined
}

/** Persisted live state per thread (R1). */
interface LiveStateEntry {
  status?: string
  work?: WorkItem[]
  streamText?: string
  statusChangedAt?: number
}

const LIVE_STATE_SCHEMA_VERSION = 1
const LIVE_STATE_DEBOUNCE_MS = 100

/** Chat-level event emitter — all chat events (from backend + JSONL polling) flow through here */
export type ChatEventHandler = (data: Record<string, unknown>) => void

/** Optional knobs for `handleSend` — only used by non-UI senders right now
 *  (the cron pipeline tags its injected text as a SYSTEM turn so the live
 *  chat.turn broadcast matches the role the SDK persists for it). UI sends
 *  omit this and default to `user`. */
export interface SendOptions {
  /** Role of the synthetic chat.turn emitted by `completeInFlight` for live
   *  SSE/WS consumers. Defaults to `'user'`. Crons pass `'system'`. */
  synthRole?: 'user' | 'system'
  /** How this message arrived — voice, AD4M, webhook, etc. Persisted on the
   *  queue and made visible to the agent via a `[presence:inbound …]`
   *  envelope when the target is the presence thread. */
  origin?: MessageOrigin
}

export interface ChatModule {
  status(): ModuleStatus
  handleSend(threadId: string, text: string, attachments?: Buffer[], opts?: SendOptions): Promise<void>
  handleAbort(threadId: string): Promise<void>
  handleHistory(threadId: string, deviceId: string): Promise<void>
  handleFullHistory(threadId: string, deviceId: string): Promise<void>
  handleSessionSwitch(threadId: string): Promise<void>
  handleSessionCreate(label?: string): Promise<{ threadId: string; sessionKey: string }>
  getSessionKeyForThread(threadId: string): string | undefined
  getThreadKeyForSession(sessionKey: string): string | undefined
  loadMapping(): void
  /** Chat-level event emitter for SSE subscriptions. Events have threadId resolved. */
  chatEvents: EventEmitter
  /** Get cached live state for a thread (for SSE replay on connect) */
  getLiveState(threadId: string): { status?: string; work?: any[]; streamText?: string }
  /** Ensure the JSONL poll is running for a thread — call when SSE connects */
  ensurePolling(threadId: string, forceStatus?: string): void
  /** Track SSE client connect/disconnect for a thread */
  trackSSEClient(threadId: string): void
  untrackSSEClient(threadId: string): void
  /** Resolve a threadId to a sessionKey, creating mapping if needed */
  resolveSessionKey(threadId: string): string
  /** Current snapshot of the server-side outbound queue for a thread. */
  getQueueSnapshot(threadId: string): QueuedMessage[]
  /** Cancel a queued or failed message by id. No-op for in-flight messages. */
  cancelQueued(id: string): boolean
  /** Re-enqueue a previously-failed message, putting it back to head of queue. */
  retryQueued(id: string): boolean
  /** Internal: the underlying queue (exposed for routes/tests; do not mutate from outside). */
  messageQueue: MessageQueue
  /** Synchronously flush all file-backed state. Called on shutdown (R5). */
  flushState(): void
}

export function createChatModule(
  bus: EventBus,
  backend: AgentBackend,
  threadManager: ThreadManager,
  options?: {
    dataDir?: string
    wsHandler?: WsHandler
    activeSessions?: ChatActiveSessionsHook
    presence?: ChatPresenceHook
  }
): ChatModule {
  const dataDir = options?.dataDir ?? '.'
  const wsHandler = options?.wsHandler
  const activeSessionsHook = options?.activeSessions
  const presenceHook = options?.presence

  // Chat-level event emitter — SSE endpoint subscribes to this
  const chatEvents = new EventEmitter()
  chatEvents.setMaxListeners(100) // support many SSE connections

  // Bidirectional mapping: threadId <-> sessionKey
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

  // ── Outbound message queue (Sovereign-owned) ─────────────────────
  // The queue is the single source of truth for a user's pending sends.
  // handleSend enqueues; the dispatch loop calls backend.sendMessage exactly
  // when the agent is idle for that thread. Clients render queued/sending/
  // failed entries directly from the queue snapshot (no separate optimistic
  // queue lives on the client).
  const messageQueue = createMessageQueue(dataDir)

  /** Threads with an in-flight send (queue head is in 'sending' status, agent
   * is processing). Used so dispatcher does not double-send while an
   * adapter+agent are mid-turn. */
  const inFlightByThread = new Map<string, string>() // threadId -> queue id

  function emitQueueSnapshot(threadId: string): void {
    const items = messageQueue.snapshot(threadId)
    const payload = { threadId, items }
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', { type: 'chat.queue', ...payload })
    }
    chatEvents.emit('chat.queue', payload)
  }

  // Any queue mutation re-broadcasts the affected thread's snapshot. Clients
  // are declarative — they trust whatever they last saw on `chat.queue`.
  messageQueue.onChange((change) => {
    emitQueueSnapshot(change.threadId)
  })

  /** Attempt to send the head of the queue for a thread if no send is
   * already in flight and the head is in 'queued' status. */
  async function pumpQueue(threadId: string): Promise<void> {
    if (inFlightByThread.has(threadId)) return
    const head = messageQueue.peek(threadId)
    if (!head || head.status !== 'queued') return

    let sessionKey = threadToSession.get(threadId)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadId)
      setMapping(threadId, sessionKey)
    }

    inFlightByThread.set(threadId, head.id)
    messageQueue.markSending(head.id)
    // Record the in-flight prompt on the liveness index so Tier 1 resume
    // can correlate the queue head with the active session after a restart.
    activeSessionsHook?.setInFlight(sessionKey, { queueId: head.id, promptText: head.text })

    // For the INTERNAL presence thread, wrap the user message in a
    // `[presence:inbound …]` envelope (so the agent sees the origin) and
    // prepend any accumulated watched-thread digest. Both hooks default to
    // no-op when presence isn't wired. The gateway thread is a normal chat
    // surface and gets no envelope/digest. See plans/presence-thread-spec.md
    // (R2, R6).
    let textToSend = head.text
    const isInternal = presenceHook && threadManager.get(threadId)?.presence === 'internal'
    if (isInternal) {
      const parts: string[] = []
      const digest = presenceHook!.takeDigest?.()
      if (digest) parts.push(digest)
      if (head.origin) {
        parts.push(`[presence:inbound ${renderOriginTag(head.origin)}]\n${head.text}`)
      } else {
        parts.push(head.text)
      }
      textToSend = parts.join('\n\n')
    }

    try {
      await backend.sendMessage(sessionKey, textToSend)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[chat] queue send failed for ${threadId} (${head.id}): ${errMsg}`)
      inFlightByThread.delete(threadId)
      messageQueue.markFailed(head.id, errMsg)
      // Surface the error to clients via chat.error too — keeps existing UI behaviour.
      const errorData = { threadId, error: errMsg, retryAfterMs: 5000 }
      if (wsHandler) {
        wsHandler.broadcastToChannel('chat', { type: 'chat.error', ...errorData })
      }
      chatEvents.emit('chat.error', errorData)
      return
    }

    // Backend accepted the message. We keep it in 'sending' state in the queue
    // and only remove it once the agent confirms the turn (chat.status → idle
    // OR chat.turn for this thread). That ensures a queued message UI item
    // stays visible until the agent has actually started — bridging the
    // gap between "POST returned" and "user message appears in history".
    const sentAt = Date.now()
    bus.emit({
      type: 'chat.message.sent',
      timestamp: new Date(sentAt).toISOString(),
      source: 'chat',
      payload: { threadId, text: head.text, timestamp: sentAt, queueId: head.id }
    })
    chatEvents.emit('chat.message.sent', { threadId, text: head.text, timestamp: sentAt, queueId: head.id })
  }

  function completeInFlight(threadId: string): void {
    const id = inFlightByThread.get(threadId)
    if (!id) return
    inFlightByThread.delete(threadId)
    // Only remove if the entry is still in 'sending' (might already have been
    // cancelled / failed elsewhere).
    const items = messageQueue.getQueue(threadId)
    const entry = items.find((m) => m.id === id)
    if (entry && entry.status === 'sending') {
      // Synthesize a chat.turn so clients can promote the queue bubble
      // into authoritative history without round-tripping for a refetch.
      // Emit BEFORE removeSent so the SSE order is: user turn → queue empty
      // → assistant turn, giving a clean visual handover with no flash.
      //
      // The role matches what the SDK will persist for this input: UI sends
      // become user turns; cron injections become system turns (the SDK
      // records `[Cron: …]` inputs as system messages, so emitting a user
      // turn here would briefly render a user bubble that flips to system
      // on the next refresh — a confusing mismatch).
      const synthRole = synthRoleById.get(id) ?? 'user'
      synthRoleById.delete(id)
      const turnPayload = {
        role: synthRole,
        content: entry.text,
        timestamp: entry.timestamp,
        workItems: [],
        thinkingBlocks: []
      }
      if (wsHandler) {
        wsHandler.broadcastToChannel('chat', { type: 'chat.turn', threadId, turn: turnPayload })
      }
      chatEvents.emit('chat.turn', { threadId, turn: turnPayload })
      messageQueue.removeSent(id)
    }
    // Try to dispatch any following queued message.
    void pumpQueue(threadId)
  }

  // Reclaim queue heads left in 'sending' state by a previous process (crash
  // or restart killed the in-flight backend subprocess; on-disk status was
  // never advanced). The new process has no in-memory ownership of these,
  // so pumpQueue would otherwise skip them forever. Reset to 'queued' and
  // pump each affected thread once.
  //
  // Cap at MAX_REQUEUE_ATTEMPTS. Without a cap, a message that keeps timing
  // out (e.g. SDK resume hanging on a huge JSONL) gets replayed on every
  // daemon restart — the user observes the same prompt firing 3+ times.
  // After the cap, mark the message 'failed' so the user can retry or
  // cancel explicitly from the UI rather than silently looping.
  const MAX_REQUEUE_ATTEMPTS = 3
  for (const [threadId, items] of messageQueue.getAllQueues()) {
    const head = items[0]
    if (!head || head.status !== 'sending') continue
    const attempts = head.attempts ?? 0
    if (attempts >= MAX_REQUEUE_ATTEMPTS) {
      console.log(
        `[chat] orphaned 'sending' queue head on ${threadId} (${head.id}, attempts=${attempts}) — exceeded max requeue, marking failed`
      )
      messageQueue.markFailed(
        head.id,
        `Backend did not complete after ${attempts} attempts. Retry or cancel from the UI.`
      )
      continue
    }
    console.log(`[chat] orphaned 'sending' queue head on ${threadId} (${head.id}, attempts=${attempts}) — requeuing`)
    if (messageQueue.markQueued(head.id)) {
      void pumpQueue(threadId)
    }
  }

  // Deduplicate rapid duplicate user sends (same text within window)
  const recentUserSends = new Map<string, { text: string; ts: number }>()
  const USER_DEDUP_WINDOW_MS = 4000

  // Track when status last changed — for stuck-status recovery.
  // 30 min covers slow SDK resumes of large JSONLs (the neural-net thread's
  // ~98 MB session can take several minutes just to rehydrate). A shorter
  // timeout (5 min was previous default) force-resets to idle mid-resume,
  // which then races with orphan-reclaim and produces duplicate replays.
  const statusChangedAt = new Map<string, number>()
  const STUCK_STATUS_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

  // Periodic check: if any thread has been "working" for too long, reset to idle
  setInterval(() => {
    const now = Date.now()
    for (const [threadId, changedAt] of statusChangedAt) {
      const status = currentStatus.get(threadId)
      if (status && status !== 'idle' && now - changedAt > STUCK_STATUS_TIMEOUT_MS) {
        console.log(
          `[chat] stuck status recovery: ${threadId} was '${status}' for ${Math.round((now - changedAt) / 1000)}s, resetting to idle`
        )
        currentStatus.set(threadId, 'idle')
        statusChangedAt.set(threadId, now)
        persistLiveState(threadId)
        stopJsonlPoll(threadId)
        // Broadcast the status change to clients
        if (wsHandler) {
          wsHandler.broadcastToChannel('chat', { type: 'chat.status', threadId, status: 'idle' })
        }
        chatEvents.emit('chat.status', { threadId, status: 'idle' })
      }
    }
  }, 30_000) // Check every 30s

  function setMapping(threadId: string, sessionKey: string): void {
    if (!threadId || !sessionKey) return // Never store empty mappings
    threadToSession.set(threadId, sessionKey)
    sessionToThread.set(sessionKey, threadId)
    persistMapping()
  }

  // --- Live state cache for replay on reconnect ---
  // Backed by `<dataDir>/chat/live-state/<encodedThreadId>.json` so resume
  // sees the same view as live operation (R1). The in-memory Maps are caches
  // over the file; on boot they're rehydrated from disk.
  const liveStateStore: WriteThroughStore<LiveStateEntry> = createWriteThroughStore<LiveStateEntry>({
    dirPath: path.join(dataDir, 'chat', 'live-state'),
    version: LIVE_STATE_SCHEMA_VERSION,
    debounceMs: LIVE_STATE_DEBOUNCE_MS,
    label: 'chat-live-state'
  })
  const currentStatus = new Map<string, string>()
  const currentWork = new Map<string, any[]>()
  const currentStreamText = new Map<string, string>()

  // Hydrate the in-memory caches from disk on boot.
  for (const { key, value } of liveStateStore.entries()) {
    if (value.status) currentStatus.set(key, value.status)
    if (value.work) currentWork.set(key, value.work)
    if (value.streamText) currentStreamText.set(key, value.streamText)
    if (value.statusChangedAt) statusChangedAt.set(key, value.statusChangedAt)
  }

  function persistLiveState(threadId: string): void {
    const status = currentStatus.get(threadId)
    const work = currentWork.get(threadId)
    const streamText = currentStreamText.get(threadId)
    const changedAt = statusChangedAt.get(threadId)
    // No active state for this thread — remove the per-thread file so the
    // directory mirrors `currently-non-idle` semantics.
    if (!status && (!work || work.length === 0) && !streamText) {
      liveStateStore.remove(threadId)
      return
    }
    liveStateStore.set(threadId, {
      status,
      work,
      streamText,
      statusChangedAt: changedAt
    })
  }

  // Proxy backend events to WS subscribers
  const backendEvents: (keyof AgentBackendEvents)[] = [
    'chat.stream',
    'chat.turn',
    'chat.status',
    'chat.work',
    'chat.compacting',
    'chat.error',
    'session.info',
    // Subagent lifecycle — forwarded so the header dropdown can refetch its
    // active-subagents list when one finishes (otherwise finished subagents
    // accumulate visually until the user closes + reopens the dropdown).
    'subagent.spawned',
    'subagent.completed',
    'subagent.failed'
  ]

  for (const eventName of backendEvents) {
    backend.on(eventName, (data: Record<string, unknown>) => {
      const sessionKey = data.sessionKey as string | undefined
      const threadId = sessionKey ? sessionToThread.get(sessionKey) : undefined

      // Cache live state per thread for replay on reconnect
      if (threadId) {
        if (eventName === 'chat.status') {
          currentStatus.set(threadId, data.status as string)
          statusChangedAt.set(threadId, Date.now())
          persistLiveState(threadId)
          if (data.status === 'idle') {
            stopJsonlPoll(threadId)
            // Agent finished a turn — clear any in-flight queue entry for this
            // thread (we've now seen the result hit our state) and try to send
            // the next queued message.
            completeInFlight(threadId)
          } else if (data.status === 'working' || data.status === 'thinking') {
            // Start polling JSONL for tool calls since gateway WS doesn't stream them
            const sessionKey2 = threadToSession.get(threadId) ?? deriveSessionKey(threadId)
            startJsonlPoll(threadId, sessionKey2)
          }
        } else if (eventName === 'chat.work') {
          const items = currentWork.get(threadId) ?? []
          items.push(data.work)
          // Cap accumulated work items to prevent unbounded growth during long agent runs
          if (items.length > 200) items.splice(0, items.length - 200)
          currentWork.set(threadId, items)
          // Clear accumulated stream text when a tool call arrives —
          // the text before the tool call was captured as a thinking item
          if ((data.work as any)?.type === 'tool_call') {
            currentStreamText.delete(threadId)
          }
          persistLiveState(threadId)
        } else if (eventName === 'chat.stream') {
          const prev = currentStreamText.get(threadId) ?? ''
          currentStreamText.set(threadId, prev + (data.text as string))
          persistLiveState(threadId)
        } else if (eventName === 'chat.turn') {
          // Turn complete — clear cached state and invalidate history cache
          currentStatus.delete(threadId)
          statusChangedAt.delete(threadId)
          currentWork.delete(threadId)
          currentStreamText.delete(threadId)
          persistLiveState(threadId)
          // A turn completing also means we should release any in-flight
          // queue entry for this thread, even if no separate 'idle' status
          // event arrives. Idempotent with the chat.status handler above.
          completeInFlight(threadId)
          // Refresh the thread's `lastActivity` so the dropdown's "Nm ago"
          // stays honest without a polling round-trip.
          try {
            threadManager.touch(threadId)
          } catch {
            /* thread may have been deleted mid-turn */
          }
          // Backend SDKs are inconsistent about whether they emit
          // `chat.status: idle` after the final assistant turn — some only
          // do it on the next user input, others not at all. Synthesize one
          // here for assistant turns so the UI converges to idle without
          // waiting on the backend. User turns (the synthetic ones we
          // generate for queued sends) must NOT trigger this, or the
          // "Thinking…" indicator gets stomped the moment the user message
          // appears.
          const turnRole = (data.turn as { role?: string } | undefined)?.role
          if (turnRole === 'assistant') {
            // Don't re-cache status — the live state map mirrors
            // currently-non-idle work, and idle is the absence of work.
            // Replaying an "idle" status on SSE reconnect just churns
            // the client without telling it anything new.
            const idleData = { sessionKey, threadId, status: 'idle' }
            if (wsHandler) {
              wsHandler.broadcastToChannel('chat', { type: 'chat.status', ...idleData })
            }
            chatEvents.emit('chat.status', idleData)
            stopJsonlPoll(threadId)
          }
        }
      }

      // Map WS message type
      const wsType = eventName === 'session.info' ? 'chat.session.info' : eventName

      // Subagent lifecycle events carry `parentKey` not `sessionKey`. The
      // header dropdown's refetch trigger only needs to know "something
      // changed" — broadcast unconditionally so the client can react even
      // when the parent thread mapping is missing (e.g. a subagent of a
      // subagent whose root hasn't been bound).
      const isSubagentEvent =
        eventName === 'subagent.spawned' || eventName === 'subagent.completed' || eventName === 'subagent.failed'

      if (wsHandler && (threadId || isSubagentEvent)) {
        wsHandler.broadcastToChannel('chat', {
          type: wsType,
          ...data,
          ...(threadId ? { threadId } : {})
        })
      }

      // Emit on chat-level emitter for SSE subscribers
      if (threadId || isSubagentEvent) {
        chatEvents.emit(wsType, { ...data, ...(threadId ? { threadId } : {}) })
      }

      // Emit bus event for chat.turn
      if (eventName === 'chat.turn' && threadId) {
        bus.emit({
          type: 'chat.turn.completed',
          timestamp: new Date().toISOString(),
          source: 'chat',
          payload: { threadId, turn: data.turn }
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
  const sseClientCount = new Map<string, number>() // track active SSE clients per thread
  function startJsonlPoll(threadId: string, sessionKey: string): void {
    if (pollTimers.has(threadId)) return // already polling

    // Resolve the JSONL file path via the backend. Backends that don't expose
    // an on-disk session file skip live polling (they're expected to stream
    // tool calls through the chat.work event).
    const filePath = backend.getSessionFilePath?.(sessionKey) ?? null
    if (!filePath) return

    // Start from current file size (only read NEW entries)
    try {
      const stat = fs.statSync(filePath)
      pollFilePositions.set(threadId, stat.size)
    } catch {
      return
    }
    pollSeenToolIds.set(threadId, new Set())

    const timer = setInterval(() => {
      try {
        const stat = fs.statSync(filePath)
        const lastPos = pollFilePositions.get(threadId) ?? 0
        if (stat.size <= lastPos) return // no new data

        // Read only the new portion
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(stat.size - lastPos)
        fs.readSync(fd, buf, 0, buf.length, lastPos)
        fs.closeSync(fd)
        pollFilePositions.set(threadId, stat.size)

        const newText = buf.toString('utf-8')
        const lines = newText.split('\n').filter(Boolean)
        const seen = pollSeenToolIds.get(threadId)!

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
                  wsHandler.broadcastToChannel('chat', { type: 'chat.work', threadId, work })
                }
                chatEvents.emit('chat.work', { threadId, work })
                const items = currentWork.get(threadId) ?? []
                items.push(work)
                currentWork.set(threadId, items)
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
                  wsHandler.broadcastToChannel('chat', { type: 'chat.work', threadId, work })
                }
                chatEvents.emit('chat.work', { threadId, work })
                const items = currentWork.get(threadId) ?? []
                items.push(work)
                currentWork.set(threadId, items)
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
            wsHandler.broadcastToChannel('chat', { type: 'chat.work', threadId, work })
          }
          chatEvents.emit('chat.work', { threadId, work })
          const items = currentWork.get(threadId) ?? []
          items.push(work)
          currentWork.set(threadId, items)
        }
        // Persist whatever new work items arrived this cycle (R1) — debounced
        // through the live-state store so high-frequency poll bumps coalesce.
        persistLiveState(threadId)
      } catch {
        /* file read error — ignore */
      }
    }, 2000) // Poll every 2s — balanced between responsiveness and CPU load

    pollTimers.set(threadId, timer)
  }

  function stopJsonlPoll(threadId: string): void {
    const timer = pollTimers.get(threadId)
    if (timer) {
      clearInterval(timer)
      pollTimers.delete(threadId)
    }
    pollFilePositions.delete(threadId)
    pollSeenToolIds.delete(threadId)
  }

  // Subagent abstract events: when the backend reports its parent has
  // spawned a child subagent, the parent is conceptually idle (waiting for
  // the child). Translate that into a chat.status event for the parent's
  // thread so the UI clears its "working" indicator.
  backend.on('subagent.spawned', (data) => {
    const parentKey = data.parentKey
    const threadId = parentKey ? sessionToThread.get(parentKey) : undefined
    if (!threadId) return
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', { type: 'chat.status', threadId, status: 'idle' })
    }
    chatEvents.emit('chat.status', { threadId, status: 'idle' })
  })

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

  // Per-queue-item synth role. Most sends are user-driven; cron injections
  // tag their item id here as `'system'` so completeInFlight emits a
  // matching live chat.turn. Persisted out-of-band (in-memory only) — losing
  // the map on restart just means a re-queued cron message is rendered as a
  // user turn one time, which is the original behaviour.
  const synthRoleById = new Map<string, 'user' | 'system'>()

  async function handleSend(
    threadIdOrLabel: string,
    text: string,
    _attachments?: Buffer[],
    opts?: SendOptions
  ): Promise<void> {
    if (!threadIdOrLabel) return // No thread — don't send
    // Accept a bare UUID or a (legacy/bookmarked) label; route by canonical id.
    const threadId = threadManager.resolve(threadIdOrLabel)?.id ?? threadIdOrLabel

    // Server-side rapid dedup (pre-queue) to prevent accidental duplicate inbound sends
    // (e.g. user double-clicks; client retries an HTTP that already succeeded).
    const last = recentUserSends.get(threadId)
    const now = Date.now()
    if (last && last.text === text && now - last.ts < USER_DEDUP_WINDOW_MS) {
      return
    }
    recentUserSends.set(threadId, { text, ts: now })

    // Ensure mapping exists up-front so the queue snapshot carries a valid
    // threadId even before the dispatcher gets to it.
    if (!threadToSession.get(threadId)) {
      setMapping(threadId, deriveSessionKey(threadId))
    }

    // Enqueue. The queue change listener will broadcast the new snapshot.
    // Then attempt to pump the queue — if the agent is idle this fires
    // immediately; if not, it'll fire when chat.status → 'idle' arrives.
    const queued = messageQueue.enqueue(threadId, text, opts?.origin ? { origin: opts.origin } : undefined)
    if (opts?.synthRole && !queued.deduplicated) {
      synthRoleById.set(queued.id, opts.synthRole)
    }
    if (opts?.origin && !queued.deduplicated) {
      // Notify presence-aware consumers (last-origin tracker, etc.).
      bus.emit({
        type: 'chat.message.origin',
        timestamp: new Date().toISOString(),
        source: 'chat',
        payload: { threadId, origin: opts.origin, queueId: queued.id }
      })
    }
    await pumpQueue(threadId)
  }

  async function handleAbort(threadId: string): Promise<void> {
    const sessionKey = threadToSession.get(threadId)
    if (sessionKey) {
      await backend.abort(sessionKey)
    }
    // After abort, the in-flight queue entry (if any) is moot — the agent
    // won't produce a turn for it. Drop it so the user can re-send.
    const id = inFlightByThread.get(threadId)
    if (id) {
      inFlightByThread.delete(threadId)
      messageQueue.removeSent(id)
    }
  }

  async function handleHistory(threadId: string, deviceId: string): Promise<void> {
    if (!threadId) return // No thread selected — nothing to fetch
    let sessionKey = threadToSession.get(threadId)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadId)
      setMapping(threadId, sessionKey)
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

    if (wsHandler) {
      wsHandler.sendTo(deviceId, { type: 'chat.session.info', threadId, sessionKey, history, hasMore })

      // Send current backend connection status so the client indicator is accurate
      wsHandler.sendTo(deviceId, { type: 'backend.status', status: backend.status() })

      // Replay cached live state so reconnecting clients see in-progress work
      const status = currentStatus.get(threadId)
      if (status && status !== 'idle') {
        wsHandler.sendTo(deviceId, { type: 'chat.status', threadId, status })
        const work = currentWork.get(threadId)
        if (work?.length) {
          for (const item of work) {
            wsHandler.sendTo(deviceId, { type: 'chat.work', threadId, work: item })
          }
        }
        const text = currentStreamText.get(threadId)
        if (text) {
          wsHandler.sendTo(deviceId, { type: 'chat.stream', threadId, text, replay: true })
        }
      }
    }
  }

  async function handleSessionSwitch(threadId: string): Promise<void> {
    const sessionKey = threadToSession.get(threadId)
    if (sessionKey) {
      await backend.switchSession(sessionKey)
    }
  }

  async function handleFullHistory(threadId: string, deviceId: string): Promise<void> {
    if (!threadId) return
    let sessionKey = threadToSession.get(threadId)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadId)
      setMapping(threadId, sessionKey)
    }

    try {
      // Full history via gateway RPC or direct file read — slower but complete
      const history = await backend.getFullHistory(sessionKey)
      // cache removed
      if (wsHandler) {
        wsHandler.sendTo(deviceId, { type: 'chat.session.info', threadId, sessionKey, history, hasMore: false })
      }
    } catch {
      // Silently fail — client already has partial history
    }
  }

  async function handleSessionCreate(label?: string): Promise<{ threadId: string; sessionKey: string }> {
    const thread = threadManager.create({ label: (label ?? '').trim() || 'untitled' })
    // sessionKey is now an identity wrapper around the UUID; kept in the
    // return shape for client-side back-compat during the cutover.
    const sessionKey = deriveSessionKey(thread.id)
    setMapping(thread.id, sessionKey)
    return { threadId: thread.id, sessionKey }
  }

  return {
    status: () => ({ name: 'chat', status: 'ok' }),
    handleSend,
    handleAbort,
    handleHistory,
    handleFullHistory,
    handleSessionSwitch,
    handleSessionCreate,
    getSessionKeyForThread: (tk: string) => threadToSession.get(tk),
    getThreadKeyForSession: (sk: string) => sessionToThread.get(sk),
    loadMapping,
    chatEvents,
    getLiveState: (threadId: string) => ({
      status: currentStatus.get(threadId),
      work: currentWork.get(threadId),
      streamText: currentStreamText.get(threadId)
    }),
    /** Ensure the JSONL poll is running for a thread — call when SSE connects */
    ensurePolling: (threadId: string, forceStatus?: string) => {
      const status = forceStatus ?? currentStatus.get(threadId)
      if (status && status !== 'idle' && !pollTimers.has(threadId) && (sseClientCount.get(threadId) ?? 0) > 0) {
        // Also update cached status so the SSE replay works
        if (forceStatus && !currentStatus.has(threadId)) {
          currentStatus.set(threadId, forceStatus)
        }
        const sessionKey = threadToSession.get(threadId) ?? deriveSessionKey(threadId)
        startJsonlPoll(threadId, sessionKey)
      }
    },
    /** Track SSE client connect/disconnect for a thread */
    trackSSEClient: (threadId: string) => {
      sseClientCount.set(threadId, (sseClientCount.get(threadId) ?? 0) + 1)
    },
    untrackSSEClient: (threadId: string) => {
      const count = (sseClientCount.get(threadId) ?? 1) - 1
      sseClientCount.set(threadId, Math.max(0, count))
      // Stop polling when no SSE clients are listening
      if (count <= 0) {
        stopJsonlPoll(threadId)
      }
    },
    resolveSessionKey: (threadIdOrLabel: string) => {
      // Accept a bare UUID or a (legacy/bookmarked) label; key by canonical id.
      const threadId = threadManager.resolve(threadIdOrLabel)?.id ?? threadIdOrLabel
      let sk = threadToSession.get(threadId)
      if (!sk) {
        sk = deriveSessionKey(threadId)
        setMapping(threadId, sk)
      }
      return sk
    },
    getQueueSnapshot: (threadId: string) => messageQueue.snapshot(threadId),
    cancelQueued: (id: string) => messageQueue.cancel(id),
    retryQueued: (id: string) => {
      const ok = messageQueue.markQueued(id)
      if (!ok) return false
      // Find the thread for this id by scanning snapshots (cheap; queues are small).
      for (const [tk, items] of messageQueue.getAllQueues()) {
        if (items.some((m) => m.id === id)) {
          void pumpQueue(tk)
          return true
        }
      }
      return true
    },
    messageQueue,
    flushState: () => liveStateStore.flush()
  }
}
