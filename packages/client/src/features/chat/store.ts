import { createSignal, createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ParsedTurn, WorkItem, AgentStatus, QueuedMessage } from '@sovereign/core'
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

// Server-side outbound queue snapshot — populated by SSE `queue` events.
// Single source of truth for messages a user has sent that the agent has
// not yet finished processing. Render queue entries as pending bubbles
// in ChatView. There is no client-side pending queue — the app assumes
// always-online; if the server is unreachable the page wouldn't load at all.
export const [serverQueue, setServerQueue] = createSignal<QueuedMessage[]>([])

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
      body: JSON.stringify({ threadId: threadKey, text })
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
  setAgentStatus('idle')
  setCompacting(false)
  clearRetryCountdown()
  stopDurationTimer()
  suppressLifecycleUntil = 0
  setHasOlderMessages(false)
  setLoadingOlder(false)
  recentUserMessages.clear()
  setServerQueue([])
  lastSSESeq = 0
  lastSentText = ''
  lastSentTime = 0
  if (import.meta?.env?.MODE === 'test') {
    chatInitialized = false
  }
}

// Client-side rapid double-submit dedup. Server has its own dedup as well;
// this just avoids burning round-trips when the user fat-fingers Enter.
let lastSentText = ''
let lastSentTime = 0

/**
 * Send a chat message. POST to /api/chat/send → server enqueues into the
 * Sovereign queue → SSE broadcasts queue snapshots → the queue bubble
 * in [ChatView](./ChatView.tsx) renders the message until the agent
 * processes it and the server emits a chat.turn for the user message.
 *
 * No optimistic turn lives in `turns()` — the queue snapshot IS the
 * visual source of truth for in-flight messages.
 */
export async function sendMessage(text: string, attachments?: File[]): Promise<void> {
  const threadKey = currentThreadKey?.() ?? ''
  if (!threadKey) return // No thread selected — nothing to send to.

  const now = Date.now()
  if (text === lastSentText && now - lastSentTime < 2000 && !attachments?.length) {
    return
  }
  lastSentText = text
  lastSentTime = now

  let body: Record<string, unknown> = { threadId: threadKey, message: text }
  if (attachments?.length) {
    const base64Files = await Promise.all(
      attachments.map(async (f) => {
        const buf = await f.arrayBuffer()
        const bytes = new Uint8Array(buf)
        let binary = ''
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
        return btoa(binary)
      })
    )
    body = { ...body, attachments: base64Files }
  }

  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Nothing else to do — the SSE `queue` event will arrive with the
    // newly-queued message and the UI updates declaratively from there.
  } catch (err) {
    // Always-online assumption: a failed POST is exceptional. Log and let
    // the user retry by clicking send again. Surfacing an inline toast
    // is a future enhancement — for now the dropped send is silent here
    // and visible only through server logs.
    console.error('[chat] send failed:', err)
  }
}

/** Cancel a server-queued message (queued OR failed). */
export function cancelQueuedMessage(id: string): void {
  fetch(`/api/chat/queue/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {
    /* server will re-broadcast queue on retry; ignore transient errors */
  })
}

/** Re-queue a failed message for another send attempt. */
export function retryQueuedMessage(id: string): void {
  fetch(`/api/chat/queue/${encodeURIComponent(id)}/retry`, { method: 'POST' }).catch(() => {
    /* ignore */
  })
}

export function loadOlderMessages(): void {
  const threadKey = currentThreadKey?.() ?? ''
  if (!ws || loadingOlder() || !hasOlderMessages() || !threadKey) return
  setLoadingOlder(true)
  ws.send({ type: 'chat.history.full', threadKey } as any)
}

export function abortChat(): void {
  const threadKey = currentThreadKey?.() ?? ''
  if (threadKey) ws?.send({ type: 'chat.abort', threadKey } as any)
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

  // ── history: full history reload via SSE (server-pushed) ──
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
      if (!agentWorkingStartTime()) startDurationTimer()
    } else {
      stopDurationTimer()
      if (data.status === 'idle') {
        clearLiveState()
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
  // The server emits TWO chat.turn events per round trip on threads driven
  // by the Sovereign queue: a synthetic user turn (emitted from
  // [completeInFlight](../../../../../../packages/chat/src/chat.ts) when the
  // queued message is acknowledged) and the agent's reply. We dedup against
  // the last turn in case history already includes it.
  eventSource.addEventListener('turn', (e) => {
    if (!checkSeq(e)) return
    const data = JSON.parse((e as MessageEvent).data)
    const turn = data.turn as ParsedTurn

    // Only the assistant's turn owns liveWork — never attach the agent's
    // tool calls / thinking to the synthetic user turn, or the UI will
    // render WorkSection above BOTH the user bubble and the assistant
    // bubble (same items shown twice). User turns always render with
    // empty workItems.
    const isUser = turn.role === 'user'
    const liveWorkItems = liveWork()
    const merged: ParsedTurn = {
      ...turn,
      workItems: isUser ? (turn.workItems ?? []) : turn.workItems?.length > 0 ? turn.workItems : liveWorkItems
    }

    setTurns((prev) => {
      const last = prev[prev.length - 1]
      if (last && last.role === merged.role && last.content === merged.content) {
        return [...prev.slice(0, -1), merged]
      }
      return [...prev, merged]
    })
    if (!isUser) clearLiveState()
  })

  // ── compacting ──
  eventSource.addEventListener('compacting', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    setCompacting(data.active)
  })

  // ── error ──
  // EventSource fires native 'error' on connection loss but auto-reconnects;
  // we don't show a banner for that (always-online assumption — the page
  // wouldn't be running if the server were genuinely gone). We DO still
  // honour custom error events with a retryAfterMs body (rate-limit hint).
  eventSource.addEventListener('error', (e) => {
    const me = e as MessageEvent
    if (!me.data) return
    try {
      const data = JSON.parse(me.data)
      if (data.retryAfterMs) {
        startRetryCountdown(data.retryAfterMs / 1000)
      }
    } catch {
      /* native connection-loss error has no payload */
    }
  })

  // ── backend-status ──
  eventSource.addEventListener('backend-status', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    setBackendStatus(data.status as ConnectionStatus)
  })

  // ── queue: server-side outbound queue snapshot ──
  // Sent on SSE connect and again on every queue mutation. Drives the
  // visible "pending" / "sending" / "failed" bubbles in the UI.
  eventSource.addEventListener('queue', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    if (data.threadKey && data.threadKey !== threadKey) return
    const items: QueuedMessage[] = Array.isArray(data.items) ? data.items : []
    setServerQueue(items)
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

  // chat.session.info from WS — response to chat.history.full requests for
  // older-message pagination. SSE handles the live event stream; this is
  // the only WS chat message the client still consumes.
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
