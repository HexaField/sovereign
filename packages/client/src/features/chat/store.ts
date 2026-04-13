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
export const [messageQueue, setMessageQueue] = createSignal<QueuedMessage[]>([])
export const [hasOlderMessages, setHasOlderMessages] = createSignal(false)
export const [loadingOlder, setLoadingOlder] = createSignal(false)

// Live streaming state — completely separate from turns[] (history)
export const [streamingText, setStreamingText] = createSignal('')
export const [streamingHtml, setStreamingHtml] = createSignal('')
export const [liveWork, setLiveWork] = createSignal<WorkItem[]>([])
export const [liveThinkingText, setLiveThinkingText] = createSignal('')

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

// Content-hash dedup window for user-message SSE events
const recentUserMessages = new Map<string, number>() // content -> timestamp
const USER_MSG_DEDUP_WINDOW_MS = 10_000

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
  setMessageQueue([])
  setHasOlderMessages(false)
  setLoadingOlder(false)
  recentUserMessages.clear()
  if (import.meta?.env?.MODE === 'test') {
    chatInitialized = false
  }
}

let lastSentText = ''
let lastSentTime = 0

export async function sendMessage(text: string, attachments?: File[]): Promise<void> {
  const threadKey = currentThreadKey?.() ?? 'main'

  // Client-side dedup: skip if same text sent within 2 seconds
  const now = Date.now()
  if (text === lastSentText && now - lastSentTime < 2000 && !attachments?.length) {
    return
  }
  lastSentText = text
  lastSentTime = now

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
    await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadKey, message: text, attachments: base64Files })
    })
  } else {
    ws?.send({ type: 'chat.send', text, threadKey } as any)
  }
}

export function loadOlderMessages(): void {
  if (!ws || loadingOlder() || !hasOlderMessages()) return
  setLoadingOlder(true)
  const threadKey = currentThreadKey?.() ?? 'main'
  ws.send({ type: 'chat.history.full', threadKey } as any)
}

export function cancelMessage(id: string): void {
  ws?.send({ type: 'chat.cancel', id } as any)
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
  const fetchHistory = (attempt = 0) => {
    fetch(`/api/threads/${encodeURIComponent(threadKey)}/history`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (data.turns?.length) {
          setTurns(data.turns)
          setHasOlderMessages(data.hasMore ?? false)
          // Only clear live state on the first history load to prevent duplicates
          // between history work items and live SSE work items.
          // After that, live state is managed by SSE events only.
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
    const data = JSON.parse((e as MessageEvent).data)
    const work = data.work as WorkItem

    if (work.type === 'tool_call') {
      const cleaned = cleanStreamText(streamingRawText)
      streamTextOffset = cleaned.length
      setStreamingText('')
      setStreamingHtml('')
    }

    if (work.type === 'thinking') {
      setLiveWork((prev) => {
        const items = [...prev]
        // If the last item is already a thinking item, replace it (accumulating text)
        // Otherwise append (thinking after tool calls should be a new entry)
        if (items.length > 0 && items[items.length - 1].type === 'thinking') {
          items[items.length - 1] = work
          return items
        }
        return [...prev, work]
      })
    } else {
      setLiveWork((prev) => [...prev, work])
    }

    if (work.type === 'thinking') {
      setLiveThinkingText(work.output || work.input || '')
    }
  })

  // ── turn: completed turn ──
  eventSource.addEventListener('turn', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    const turn = data.turn as ParsedTurn
    turnReceivedForCurrentRun = true

    const liveWorkItems = liveWork()
    const merged: ParsedTurn = {
      ...turn,
      workItems: turn.workItems?.length > 0 ? turn.workItems : liveWorkItems
    }

    setTurns((prev) => [...prev, merged])
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

  // ── queue ──
  eventSource.addEventListener('queue', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    setMessageQueue(data.queue ?? [])
  })

  // ── user-message: sync user messages across tabs ──
  eventSource.addEventListener('user-message', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    const text = data.text as string
    if (!text) return

    // Content-hash dedup: skip if we've seen identical text within the window
    const now = Date.now()
    const trimmed = text.trim()
    const prevTs = recentUserMessages.get(trimmed)
    if (prevTs !== undefined && now - prevTs < USER_MSG_DEDUP_WINDOW_MS) {
      return
    }
    recentUserMessages.set(trimmed, now)
    // Prune old entries
    for (const [k, ts] of recentUserMessages) {
      if (now - ts > USER_MSG_DEDUP_WINDOW_MS) recentUserMessages.delete(k)
    }

    setTurns((prev) => {
      // Also check against existing turns (belt-and-suspenders)
      const last = prev.filter((t) => t.role === 'user').pop()
      if (
        last &&
        last.content === trimmed &&
        Math.abs((last.timestamp || 0) - (data.timestamp || now)) < USER_MSG_DEDUP_WINDOW_MS
      ) {
        return prev
      }
      return [
        ...prev,
        {
          role: 'user' as const,
          content: text,
          timestamp: data.timestamp || Date.now(),
          workItems: [],
          thinkingBlocks: []
        }
      ]
    })
  })
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

  const trackEffect = createEffect(() => {
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

  // ── WS listeners we still need ──

  // chat.error from WS (retry countdown)
  unsubs.push(
    ws.on('chat.error', (msg: any) => {
      if (msg.retryAfterMs) {
        startRetryCountdown(msg.retryAfterMs / 1000)
      }
    })
  )

  // chat.session.info from WS (for full history load response)
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
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const turn = msg.turn as ParsedTurn
      if (!turn) return
      setTurns((prev) => [...prev, turn])
    })
  )

  // chat.stream from WS (fallback)
  unsubs.push(
    ws.on('chat.stream', (msg: any) => {
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
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      if (msg.status) setAgentStatus(msg.status)
    })
  )

  // chat.work from WS (fallback)
  unsubs.push(
    ws.on('chat.work', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const work = msg.work as WorkItem
      if (!work) return
      setLiveWork((prev) => [...prev, work])
      if (work.type === 'thinking') setLiveThinkingText(work.output || work.input || '')
    })
  )

  // chat.compacting from WS (fallback)
  unsubs.push(
    ws.on('chat.compacting', (msg: any) => {
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
