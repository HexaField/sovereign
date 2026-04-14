import { createSignal, createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ParsedTurn, WorkItem, AgentStatus } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'
import { renderMarkdown, stripThinkingBlocks } from '../../lib/markdown.js'
import { setBackendStatus, type ConnectionStatus } from '../connection/store.js'

export const [turns, setTurns] = createSignal<ParsedTurn[]>([])
export const [agentStatus, setAgentStatus] = createSignal<AgentStatus>('idle')
export const [compacting, setCompacting] = createSignal(false)
export const [agentWorkingStartTime, setAgentWorkingStartTime] = createSignal<number | null>(null)
export const [agentDurationText, setAgentDurationText] = createSignal('')
export const [isRetryCountdownActive, setRetryActive] = createSignal(false)
export const [retryCountdownSeconds, setRetrySeconds] = createSignal(0)
export const [inputValue, _setInputValue] = createSignal('')
export const [hasOlderMessages, setHasOlderMessages] = createSignal(false)
export const [loadingOlder, setLoadingOlder] = createSignal(false)

// Live streaming state — completely separate from turns[] (history)
export const [streamingText, setStreamingText] = createSignal('')
export const [streamingHtml, setStreamingHtml] = createSignal('')
export const [liveWork, setLiveWork] = createSignal<WorkItem[]>([])
export const [liveThinkingText, setLiveThinkingText] = createSignal('')

// §R.5 Offline pending queue
export interface PendingMessage {
  id: string
  text: string
  threadKey: string
  timestamp: number
  retries: number
  status: 'pending' | 'sending' | 'failed'
}
export const [pendingQueue, setPendingQueue] = createSignal<PendingMessage[]>([])

// §R.8 Connection loss banner
export const [connectionLost, setConnectionLost] = createSignal(false)

function draftKey(threadKey: string): string {
  return `sovereign:draft:${threadKey}`
}

// ── Debounced server draft save ──────────────────────────────────────
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null

function debounceSaveDraftToServer(threadKey: string, text: string): void {
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  draftSaveTimer = setTimeout(() => {
    fetch('/api/chat/draft', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadKey, text })
    }).catch(() => {
      /* ignore */
    })
  }, 300)
}

export function setInputValue(v: string): void {
  _setInputValue(v)
  if (currentThreadKey) {
    const tk = currentThreadKey()
    if (tk) {
      // Write-through to localStorage for instant local response
      try {
        localStorage.setItem(draftKey(tk), v)
      } catch {
        /* ignore */
      }
      // Debounce-save to server for cross-device sync
      debounceSaveDraftToServer(tk, v)
    }
  }
}

function loadDraft(threadKey: string): void {
  // Load from localStorage immediately for instant display
  try {
    const saved = localStorage.getItem(draftKey(threadKey))
    _setInputValue(saved ?? '')
  } catch {
    _setInputValue('')
  }
  // Then fetch from server and override if different
  fetch(`/api/chat/draft?thread=${encodeURIComponent(threadKey)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && typeof data.text === 'string') {
        _setInputValue(data.text)
        try {
          localStorage.setItem(draftKey(threadKey), data.text)
        } catch {
          /* */
        }
      }
    })
    .catch(() => {
      /* ignore, keep localStorage value */
    })
}

let durationTimer: ReturnType<typeof setInterval> | null = null

function startDurationTimer(): void {
  stopDurationTimer()
  setAgentWorkingStartTime(Date.now())
  updateDurationText()
  durationTimer = setInterval(updateDurationText, 1000)
}

function stopDurationTimer(): void {
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  setAgentWorkingStartTime(null)
  setAgentDurationText('')
}

function updateDurationText(): void {
  const start = agentWorkingStartTime()
  if (!start) return
  const elapsed = Math.floor((Date.now() - start) / 1000)
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  setAgentDurationText(`${mins}:${secs.toString().padStart(2, '0')}`)
}

let retryTimer: ReturnType<typeof setInterval> | null = null
let ws: WsStore | null = null
let suppressLifecycleUntil = 0
let currentThreadKey: Accessor<string> | null = null

// Accumulated raw streaming text for the current in-progress turn
let streamingRawText = ''
// Offset into cleanStreamText after the last tool call — show only text after this point
let streamTextOffset = 0

// SSE connection
let eventSource: EventSource | null = null
// SSE sequence tracking for gap detection
let lastSSESeq = 0

// Content-hash dedup window for user-message SSE events
const recentUserMessages = new Map<string, number>() // content -> timestamp

// §R.4 Send timeout guard — pending ack map
const SEND_TIMEOUT_MS = 15_000
const MAX_SEND_RETRIES = 3
const pendingAcks = new Map<string, { timer: ReturnType<typeof setTimeout>; msg: PendingMessage }>()

export function startRetryCountdown(seconds: number): void {
  clearRetryCountdown()
  setRetrySeconds(Math.ceil(seconds))
  setRetryActive(true)
  retryTimer = setInterval(() => {
    const next = retryCountdownSeconds() - 1
    setRetrySeconds(next)
    if (next <= 0) clearRetryCountdown()
  }, 1000)
}

export function clearRetryCountdown(): void {
  if (retryTimer) {
    clearInterval(retryTimer)
    retryTimer = null
  }
  setRetryActive(false)
  setRetrySeconds(0)
}

// ── Helpers ──────────────────────────────────────────────────

// Change 3: Deterministic turn completion flag
let turnReceivedForCurrentRun = false

/** Clear all live streaming state */
function clearLiveState(): void {
  streamingRawText = ''
  streamTextOffset = 0
  setStreamingText('')
  setStreamingHtml('')
  setLiveWork([])
  setLiveThinkingText('')
}

/** Clean text: strip thinking blocks and directive tags */
function cleanStreamText(raw: string): string {
  return stripThinkingBlocks(raw)
    .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
    .trim()
}

function getThinkingText(item: WorkItem | undefined): string {
  return (item?.output || item?.input || '').trim()
}

function shouldReplaceThinkingItem(previous: WorkItem | undefined, next: WorkItem): boolean {
  if (!previous || previous.type !== 'thinking' || next.type !== 'thinking') return false

  const previousText = getThinkingText(previous)
  const nextText = getThinkingText(next)
  if (!previousText || !nextText) return false

  return nextText.startsWith(previousText)
}

export function mergeLiveWorkItems(previousItems: WorkItem[], nextItem: WorkItem): WorkItem[] {
  if (nextItem.type !== 'thinking') {
    return [...previousItems, nextItem]
  }

  if (previousItems.length === 0) {
    return [nextItem]
  }

  const items = [...previousItems]
  const lastItem = items[items.length - 1]
  if (shouldReplaceThinkingItem(lastItem, nextItem)) {
    items[items.length - 1] = nextItem
    return items
  }

  items.push(nextItem)
  return items
}

// ─────────────────────────────────────────────────────────────

function resetState(): void {
  setTurns([])
  clearLiveState()
  turnReceivedForCurrentRun = false
  setAgentStatus('idle')
  setCompacting(false)
  clearRetryCountdown()
  stopDurationTimer()
  suppressLifecycleUntil = 0
  setHasOlderMessages(false)
  setLoadingOlder(false)
  recentUserMessages.clear()
  // Clear pending queue and ack timers
  for (const [, entry] of pendingAcks) clearTimeout(entry.timer)
  pendingAcks.clear()
  setPendingQueue([])
  setConnectionLost(false)
  lastSSESeq = 0
  resetSendState()
  if (import.meta?.env?.MODE === 'test') {
    chatInitialized = false
  }
}

let lastSentText = ''
let lastSentTime = 0
let ackCounter = 0

function resetSendState(): void {
  lastSentText = ''
  lastSentTime = 0
  ackCounter = 0
}

/** §R.6 Exponential backoff delay for send retries */
function retryBackoffMs(retries: number): number {
  return Math.min(1000 * Math.pow(2, retries), 30_000) * (0.5 + Math.random() * 0.5)
}

/** §R.5 Flush pending queue — attempt to send next pending message */
function flushPendingQueue(): void {
  const queue = pendingQueue()
  const next = queue.find((m) => m.status === 'pending')
  if (!next) return
  if (!ws?.connected()) return
  doSend(next)
}

/** Internal: send a pending message with ack tracking */
function doSend(pending: PendingMessage): void {
  const ackId = `ack-${++ackCounter}-${Date.now()}`

  setPendingQueue((q) => q.map((m) => (m.id === pending.id ? { ...m, status: 'sending' as const } : m)))

  // Set up timeout guard
  const timer = setTimeout(() => {
    pendingAcks.delete(ackId)
    if (pending.retries < MAX_SEND_RETRIES) {
      // §R.6 Retry with backoff
      const delay = retryBackoffMs(pending.retries)
      setPendingQueue((q) =>
        q.map((m) => (m.id === pending.id ? { ...m, status: 'pending' as const, retries: m.retries + 1 } : m))
      )
      setTimeout(() => flushPendingQueue(), delay)
    } else {
      // Mark as failed after max retries
      setPendingQueue((q) => q.map((m) => (m.id === pending.id ? { ...m, status: 'failed' as const } : m)))
      // Mark the corresponding optimistic turn as failed
      setTurns((prev) => {
        const updated = [...prev]
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'user' && updated[i].content === pending.text && !updated[i].sendFailed) {
            updated[i] = { ...updated[i], sendFailed: true }
            break
          }
        }
        return updated
      })
    }
  }, SEND_TIMEOUT_MS)

  pendingAcks.set(ackId, { timer, msg: pending })

  try {
    ws?.send({ type: 'chat.send', text: pending.text, threadKey: pending.threadKey, ackId } as any)
  } catch {
    clearTimeout(timer)
    pendingAcks.delete(ackId)
    setPendingQueue((q) => q.map((m) => (m.id === pending.id ? { ...m, status: 'failed' as const } : m)))
  }
}

/** Handle ack from server — message accepted */
export function handleAck(ackId: string): void {
  const entry = pendingAcks.get(ackId)
  if (!entry) return
  clearTimeout(entry.timer)
  pendingAcks.delete(ackId)
  // Remove from pending queue
  setPendingQueue((q) => q.filter((m) => m.id !== entry.msg.id))
  // Send next queued message
  flushPendingQueue()
}

/** Handle nack from server — message rejected */
export function handleNack(ackId: string, error?: string): void {
  const entry = pendingAcks.get(ackId)
  if (!entry) return
  void error
  clearTimeout(entry.timer)
  pendingAcks.delete(ackId)
  // Mark the send as failed
  setPendingQueue((q) => q.map((m) => (m.id === entry.msg.id ? { ...m, status: 'failed' as const } : m)))
  setTurns((prev) => {
    const updated = [...prev]
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].role === 'user' && updated[i].content === entry.msg.text && !updated[i].sendFailed) {
        updated[i] = { ...updated[i], sendFailed: true }
        break
      }
    }
    return updated
  })
}

export async function sendMessage(text: string, attachments?: File[]): Promise<void> {
  const threadKey = currentThreadKey?.() ?? 'main'

  // Client-side dedup: skip if same text sent within 2 seconds
  const now = Date.now()
  if (text === lastSentText && now - lastSentTime < 2000 && !attachments?.length) {
    return
  }
  lastSentText = text
  lastSentTime = now

  // Optimistic: add user turn immediately (single source of truth before history replaces it)
  setTurns((prev) => [
    ...prev,
    {
      role: 'user' as const,
      content: text,
      timestamp: Date.now(),
      workItems: [],
      thinkingBlocks: [],
      pending: true
    }
  ])

  try {
    if (attachments?.length) {
      // Use HTTP POST with base64 attachments
      const base64Files = await Promise.all(
        attachments.map(async (f) => {
          const buf = await f.arrayBuffer()
          const bytes = new Uint8Array(buf)
          let binary = ''
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
          return btoa(binary)
        })
      )
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadKey, message: text, attachments: base64Files })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Mark optimistic turn as confirmed
      setTurns((prev) => prev.map((t) => (t.pending && t.content === text ? { ...t, pending: false } : t)))
    } else {
      // §R.5 Add to pending queue and send with ack tracking
      const pending: PendingMessage = {
        id: `pm-${++ackCounter}-${Date.now()}`,
        text,
        threadKey,
        timestamp: Date.now(),
        retries: 0,
        status: ws?.connected() ? 'pending' : 'pending'
      }
      setPendingQueue((q) => [...q, pending])

      if (ws?.connected()) {
        doSend(pending)
      }
      // If offline, message stays in queue and flushPendingQueue runs on reconnect
    }
  } catch {
    // Mark the optimistic turn as failed
    setTurns((prev) => {
      const updated = [...prev]
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].role === 'user' && updated[i].content === text && !updated[i].sendFailed) {
          updated[i] = { ...updated[i], sendFailed: true, pending: false }
          break
        }
      }
      return updated
    })
  }
}

export function retrySend(turn: ParsedTurn): void {
  // Remove the failed turn and re-send
  const text = turn.content
  setTurns((prev) => prev.filter((t) => t !== turn))
  sendMessage(text)
}

export function cancelFailedMessage(turn: ParsedTurn): void {
  setTurns((prev) => prev.filter((t) => t !== turn))
}

export function loadOlderMessages(): void {
  if (!ws || loadingOlder() || !hasOlderMessages()) return
  setLoadingOlder(true)
  const threadKey = currentThreadKey?.() ?? 'main'
  ws.send({ type: 'chat.history.full', threadKey } as any)
}

export function abortChat(): void {
  ws?.send({ type: 'chat.abort', threadKey: currentThreadKey?.() ?? 'main' } as any)
  clearLiveState()
  suppressLifecycleUntil = Date.now() + 2000
  setAgentStatus('cancelled' as AgentStatus)
  setTimeout(() => {
    setAgentStatus('idle')
  }, 1500)
}

// ── SSE connection management ────────────────────────────────

function connectSSE(threadKey: string): void {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
  if (!threadKey) return

  // Fetch history via HTTP GET immediately (fast, parallel with SSE)
  let historyLoaded = false
  let historyETag: string | null = null // §R.7 ETag for cache validation
  const fetchHistory = (attempt = 0) => {
    const headers: Record<string, string> = {}
    if (historyETag) headers['If-None-Match'] = historyETag
    fetch(`/api/threads/${encodeURIComponent(threadKey)}/history`, { headers })
      .then((r) => {
        if (r.status === 304) return null // §R.7 Not modified — cache is valid
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const etag = r.headers.get('ETag')
        if (etag) historyETag = etag
        return r.json()
      })
      .then((data) => {
        if (!data) return // 304 response
        if (data.turns?.length) {
          setTurns(data.turns)
          setHasOlderMessages(data.hasMore ?? false)
          if (!historyLoaded) {
            historyLoaded = true
            clearLiveState()
          }
        }
      })
      .catch(() => {
        // Retry up to 3 times with backoff (handles ERR_CONTENT_LENGTH_MISMATCH)
        if (attempt < 3) setTimeout(() => fetchHistory(attempt + 1), 1000 * (attempt + 1))
      })
  }
  fetchHistory()

  if (typeof EventSource === 'undefined') return
  const url = `/api/threads/${encodeURIComponent(threadKey)}/events`
  eventSource = new EventSource(url)
  lastSSESeq = 0

  // §R.3 SSE sequence gap detection
  function checkSeq(e: Event): boolean {
    const me = e as MessageEvent
    if (me.lastEventId) {
      const seq = parseInt(me.lastEventId, 10)
      if (!isNaN(seq)) {
        if (lastSSESeq > 0 && seq > lastSSESeq + 1) {
          // Gap detected — reconnect to get fresh state
          console.warn(`[chat] SSE gap: expected ${lastSSESeq + 1}, got ${seq}. Reconnecting...`)
          lastSSESeq = seq
          // Fetch fresh history to reconcile
          fetchHistory()
          return false
        }
        lastSSESeq = seq
      }
    }
    return true
  }

  // §R.8 Track SSE open/error for connection loss banner
  eventSource.onopen = () => {
    setConnectionLost(false)
  }

  // ── history: reconnect / full history reload via SSE (fallback) ──
  eventSource.addEventListener('history', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    setTurns(data.turns ?? [])
    setHasOlderMessages(data.hasMore ?? false)
    setLoadingOlder(false)
    clearLiveState()
  })

  // ── status: agent status changes ──
  eventSource.addEventListener('status', (e) => {
    if (!checkSeq(e)) return
    const data = JSON.parse((e as MessageEvent).data)
    if (Date.now() < suppressLifecycleUntil && data.status !== 'idle') return
    setAgentStatus(data.status)
    if (data.status === 'working' || data.status === 'thinking') {
      turnReceivedForCurrentRun = false
      if (!agentWorkingStartTime()) startDurationTimer()
    } else {
      stopDurationTimer()
      if (data.status === 'idle') {
        clearLiveState()
        // If chat.turn already arrived, we're done. Otherwise SSE will re-send history on reconnect.
        if (!turnReceivedForCurrentRun) {
          // Request history via WS as fallback
          ws?.send({ type: 'chat.history', threadKey } as any)
        }
      }
    }
  })

  // ── stream: text streaming deltas ──
  eventSource.addEventListener('stream', (e) => {
    if (!checkSeq(e)) return
    const data = JSON.parse((e as MessageEvent).data)
    const isSubagent = threadKey.startsWith('subagent:')

    if (data.replay) {
      streamingRawText = data.text
    } else {
      streamingRawText += data.text
    }

    const cleaned = cleanStreamText(streamingRawText)
    const visible = cleaned.substring(streamTextOffset).trim()
    const isSentinel = /^(NO_REPLY|HEARTBEAT_OK|NO_?|HEART)/.test(visible) && visible.length < 15

    if (visible && !isSubagent && !isSentinel) {
      setStreamingText(visible)
      setStreamingHtml(renderMarkdown(visible))
    } else if (isSubagent && cleaned) {
      setAgentStatus('working')
    }
  })

  // ── work: tool calls, tool results, thinking blocks ──
  eventSource.addEventListener('work', (e) => {
    if (!checkSeq(e)) return
    const data = JSON.parse((e as MessageEvent).data)
    const work = data.work as WorkItem

    if (work.type === 'tool_call') {
      const cleaned = cleanStreamText(streamingRawText)
      streamTextOffset = cleaned.length
      setStreamingText('')
      setStreamingHtml('')
    }

    setLiveWork((prev) => mergeLiveWorkItems(prev, work))

    if (work.type === 'thinking') {
      setLiveThinkingText(work.output || work.input || '')
    }
  })

  // ── turn: completed turn ──
  eventSource.addEventListener('turn', (e) => {
    if (!checkSeq(e)) return
    const data = JSON.parse((e as MessageEvent).data)
    const turn = data.turn as ParsedTurn
    turnReceivedForCurrentRun = true

    const liveWorkItems = liveWork()
    const merged: ParsedTurn = {
      ...turn,
      workItems: turn.workItems?.length > 0 ? turn.workItems : liveWorkItems
    }

    // §R.2 Optimistic reconciliation — match server turn against pending optimistic turns
    setTurns((prev) => {
      // Guard against duplicate turn content (e.g. optimistic user turn + authoritative turn)
      const last = prev[prev.length - 1]
      if (last && last.role === merged.role && last.content === merged.content) {
        // Replace last turn with the authoritative one (has workItems etc.) and clear pending flag
        return [...prev.slice(0, -1), { ...merged, pending: false, sendFailed: false }]
      }
      // Check for pending user turn that matches this turn (may not be last)
      if (merged.role === 'user') {
        const pendingIdx = prev.findIndex((t) => t.role === 'user' && t.pending && t.content === merged.content)
        if (pendingIdx >= 0) {
          const updated = [...prev]
          updated[pendingIdx] = { ...merged, pending: false, sendFailed: false }
          return updated
        }
      }
      return [...prev, merged]
    })
    clearLiveState()
  })

  // ── compacting ──
  eventSource.addEventListener('compacting', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    setCompacting(data.active)
  })

  // ── error ──
  eventSource.addEventListener('error', (e) => {
    // SSE spec: EventSource fires 'error' on connection loss — it auto-reconnects
    // §R.8 Connection loss banner
    if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      setConnectionLost(true)
    } else if (eventSource && eventSource.readyState === EventSource.CONNECTING) {
      setConnectionLost(true)
    }
    // Only handle our custom error events (they have data)
    const me = e as MessageEvent
    if (me.data) {
      try {
        const data = JSON.parse(me.data)
        if (data.retryAfterMs) {
          startRetryCountdown(data.retryAfterMs / 1000)
        }
      } catch {
        // Native SSE error (connection lost) — auto-reconnects
      }
    }
  })

  // ── backend-status ──
  eventSource.addEventListener('backend-status', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    setBackendStatus(data.status as ConnectionStatus)
  })

  // user-message SSE event removed — user turns are added optimistically in sendMessage()
  // and history fetches are the authoritative source of truth
}

function disconnectSSE(): void {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

let chatInitialized = false
export function initChatStore(_threadKey: Accessor<string>, wsStore?: WsStore): (() => void) | void {
  ws = wsStore ?? null
  currentThreadKey = _threadKey
  if (!ws) return
  if (chatInitialized) return
  chatInitialized = true

  // Subscribe to WS for sending messages + features that still use WS
  ws.subscribe(['chat'])

  if (_threadKey()) {
    connectSSE(_threadKey())
    loadDraft(_threadKey())
  }

  let prevThreadKey = _threadKey()
  const unsubs: Array<() => void> = []

  createEffect(() => {
    const key = _threadKey()
    if (key !== prevThreadKey) {
      prevThreadKey = key
      resetState()
      loadDraft(key)
      if (key) {
        connectSSE(key)
        ws?.send({ type: 'chat.session.switch', threadKey: key } as any)
      } else {
        disconnectSSE()
      }
    }
  })

  clearLiveState()

  // §R.1 WS ack/nack handlers
  unsubs.push(
    ws.on('ack', (msg: any) => {
      handleAck(msg.ackId)
    })
  )
  unsubs.push(
    ws.on('nack', (msg: any) => {
      handleNack(msg.ackId, msg.error)
    })
  )

  // §R.5 Flush pending queue on WS reconnect
  unsubs.push(
    ws.on('ws.reconnected', () => {
      setConnectionLost(false)
      flushPendingQueue()
    })
  )

  // ── WS listeners (fallback — only active when SSE is not connected) ──

  // Helper: true when SSE is connected and receiving events for this thread
  const sseActive = () => eventSource !== null && eventSource.readyState !== EventSource.CLOSED

  // chat.error from WS (retry countdown) — always active, SSE also handles it
  unsubs.push(
    ws.on('chat.error', (msg: any) => {
      if (sseActive()) return // SSE has its own error handler
      if (msg.retryAfterMs) {
        startRetryCountdown(msg.retryAfterMs / 1000)
      }
    })
  )

  // chat.session.info from WS (for full history load response) — always active
  // This is only sent via WS (sendTo), not SSE, so no duplication risk
  unsubs.push(
    ws.on('chat.session.info', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const history: ParsedTurn[] = msg.history ?? []
      setHasOlderMessages(msg.hasMore ?? false)
      setLoadingOlder(false)
      setTurns(history)
      clearLiveState()
    })
  )

  // chat.turn from WS (fallback when SSE isn't available, e.g. tests)
  unsubs.push(
    ws.on('chat.turn', (msg: any) => {
      if (sseActive()) return // SSE handles turn events — skip to avoid duplicates
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const turn = msg.turn as ParsedTurn
      if (!turn) return
      setTurns((prev) => [...prev, turn])
    })
  )

  // chat.stream from WS (fallback)
  unsubs.push(
    ws.on('chat.stream', (msg: any) => {
      if (sseActive()) return
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const text = msg.text as string
      if (text === undefined) return
      if (msg.replay) {
        streamingRawText = text
      } else {
        streamingRawText += text
      }
      const cleaned = cleanStreamText(streamingRawText)
      if (cleaned === 'NO_REPLY' || cleaned === 'HEARTBEAT_OK') {
        setStreamingHtml('')
        return
      }
      setStreamingHtml(renderMarkdown(cleaned))
    })
  )

  // chat.status from WS (fallback)
  unsubs.push(
    ws.on('chat.status', (msg: any) => {
      if (sseActive()) return
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      if (msg.status) setAgentStatus(msg.status)
    })
  )

  // chat.work from WS (fallback)
  unsubs.push(
    ws.on('chat.work', (msg: any) => {
      if (sseActive()) return
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const work = msg.work as WorkItem
      if (!work) return
      setLiveWork((prev) => mergeLiveWorkItems(prev, work))
      if (work.type === 'thinking') setLiveThinkingText(work.output || work.input || '')
    })
  )

  // chat.compacting from WS (fallback)
  unsubs.push(
    ws.on('chat.compacting', (msg: any) => {
      if (sseActive()) return
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      if (typeof msg.active === 'boolean') setCompacting(msg.active)
    })
  )

  // Thread event routing (still via WS)
  unsubs.push(
    ws.on('thread.event.routed' as any, (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const entity = msg.entityBinding
      const evtType = msg.event?.type ?? 'unknown'
      const text = `[${msg.classification ?? 'NOTIFY'}] ${evtType} on ${entity?.entityType ?? ''}:${entity?.entityRef ?? ''}`
      setTurns((prev) => [
        ...prev,
        {
          role: 'system',
          content: text,
          timestamp: msg.event?.timestamp ?? new Date().toISOString()
        } as ParsedTurn
      ])
    })
  )

  // Visibility change — SSE auto-reconnects, but if we want fresh data on visibility:
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      const key = _threadKey()
      // SSE auto-reconnects and sends fresh history, but if it's already connected
      // and we just want a refresh while idle, we can re-connect
      if (key && (!eventSource || eventSource.readyState === EventSource.CLOSED)) {
        connectSSE(key)
      }
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    unsubs.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  return () => {
    unsubs.forEach((u) => u())
    disconnectSSE()
    ws?.unsubscribe(['chat'])
    chatInitialized = false
  }
}

// Expose for testing
export { resetState as _resetState }
