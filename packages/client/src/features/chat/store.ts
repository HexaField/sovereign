import { createSignal, createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ParsedTurn, WorkItem, AgentStatus, QueuedMessage } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'
import { renderMarkdown, stripThinkingBlocks } from '../../lib/markdown.js'

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

export function setInputValue(v: string): void {
  _setInputValue(v)
  if (currentThreadKey) {
    const tk = currentThreadKey()
    if (tk) {
      try {
        localStorage.setItem(draftKey(tk), v)
      } catch {
        /* ignore */
      }
    }
  }
}

function loadDraft(threadKey: string): void {
  try {
    const saved = localStorage.getItem(draftKey(threadKey))
    _setInputValue(saved ?? '')
  } catch {
    _setInputValue('')
  }
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
}

export function sendMessage(text: string, _attachments?: File[]): void {
  // Send to server — the message will appear in chat when the server
  // processes it and sends back history via chat.session.info / chat.turn.
  // The queue UI shows it as pending in the meantime.
  ws?.send({ type: 'chat.send', text, threadKey: currentThreadKey?.() ?? 'main' } as any)
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

let chatInitialized = false
export function initChatStore(_threadKey: Accessor<string>, wsStore?: WsStore): (() => void) | void {
  ws = wsStore ?? null
  currentThreadKey = _threadKey
  if (!ws) return
  if (chatInitialized) return
  chatInitialized = true

  ws.subscribe(['chat'])

  if (_threadKey()) {
    ws.send({ type: 'chat.history', threadKey: _threadKey() } as any)
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
        ws?.send({ type: 'chat.history', threadKey: key } as any)
        ws?.send({ type: 'chat.session.switch', threadKey: key } as any)
      }
    }
  })

  clearLiveState()

  // ── chat.stream: update live streaming text (NOT turns[]) ──
  unsubs.push(
    ws.on('chat.stream', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return

      const isSubagent = _threadKey().startsWith('subagent:')

      if (msg.replay) {
        streamingRawText = msg.text
      } else {
        streamingRawText += msg.text
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
  )

  // ── chat.turn: final turn from server — update history, clear live state ──
  unsubs.push(
    ws.on('chat.turn', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const turn = msg.turn as ParsedTurn
      turnReceivedForCurrentRun = true

      // Merge any live work items into the final turn if it has none
      const liveWorkItems = liveWork()
      const merged: ParsedTurn = {
        ...turn,
        workItems: turn.workItems?.length > 0 ? turn.workItems : liveWorkItems
      }

      setTurns((prev) => [...prev, merged])
      clearLiveState()
    })
  )

  // ── chat.status: track agent status, deterministic turn completion ──
  unsubs.push(
    ws.on('chat.status', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      if (Date.now() < suppressLifecycleUntil && msg.status !== 'idle') return
      setAgentStatus(msg.status)
      if (msg.status === 'working' || msg.status === 'thinking') {
        turnReceivedForCurrentRun = false
        if (!agentWorkingStartTime()) startDurationTimer()
      } else {
        stopDurationTimer()
        if (msg.status === 'idle') {
          clearLiveState()
          // If chat.turn already arrived, we're done. Otherwise reload history as fallback.
          if (!turnReceivedForCurrentRun) {
            const threadKey = currentThreadKey?.() ?? 'main'
            ws?.send({ type: 'chat.history', threadKey } as any)
          }
        }
      }
    })
  )

  // ── chat.work: update live work items only (NOT turns[]) ──
  unsubs.push(
    ws.on('chat.work', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const work = msg.work as WorkItem

      if (work.type === 'tool_call') {
        // Advance text offset so streaming bubble only shows text after this tool call
        const cleaned = cleanStreamText(streamingRawText)
        streamTextOffset = cleaned.length
        setStreamingText('')
        setStreamingHtml('')
      }

      if (work.type === 'thinking') {
        // Replace the last thinking item (accumulated text)
        setLiveWork((prev) => {
          const items = [...prev]
          const lastThinkIdx = items.findLastIndex((w) => w.type === 'thinking')
          if (lastThinkIdx >= 0) {
            items[lastThinkIdx] = work
            return items
          }
          return [...prev, work]
        })
      } else {
        setLiveWork((prev) => [...prev, work])
      }

      setLiveThinkingText(work.type === 'thinking' ? work.output || work.input || '' : '')
    })
  )

  unsubs.push(
    ws.on('chat.compacting', (msg: any) => {
      setCompacting(msg.active)
    })
  )

  unsubs.push(
    ws.on('chat.error', (msg: any) => {
      if (msg.retryAfterMs) {
        startRetryCountdown(msg.retryAfterMs / 1000)
      }
    })
  )

  // ── chat.session.info: full history replace ──
  let _hasOlderMessages = false
  unsubs.push(
    ws.on('chat.session.info', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const history: ParsedTurn[] = msg.history ?? []
      _hasOlderMessages = msg.hasMore ?? false
      setHasOlderMessages(_hasOlderMessages)
      setLoadingOlder(false)
      setTurns(history)
      clearLiveState()
    })
  )

  // Queue updates
  unsubs.push(
    ws.on('chat.queue.update' as any, (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      setMessageQueue(msg.queue ?? [])
    })
  )

  // ── chat.user-message: sync user messages across tabs/devices ──
  unsubs.push(
    ws.on('chat.user-message' as any, (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      // Add the user turn if it's not already in the list
      // (the sending tab may have already added it optimistically — but we removed that)
      const text = msg.text as string
      if (!text) return
      setTurns((prev) => {
        // Deduplicate: skip if the last user turn has the same text within 5 seconds
        const last = prev.filter((t) => t.role === 'user').pop()
        if (last && last.content === text && Math.abs((last.timestamp || 0) - (msg.timestamp || Date.now())) < 5000) {
          return prev
        }
        return [
          ...prev,
          {
            role: 'user' as const,
            content: text,
            timestamp: msg.timestamp || Date.now(),
            workItems: [],
            thinkingBlocks: []
          }
        ]
      })
    })
  )

  // Thread event routing
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

  // Reconnect — re-fetch history
  unsubs.push(
    ws.on('ws.reconnected' as any, () => {
      const key = _threadKey()
      if (key) {
        ws?.send({ type: 'chat.history', threadKey: key } as any)
      }
    })
  )

  // Visibility change — re-fetch if idle
  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      const key = _threadKey()
      const status = agentStatus()
      if (key && ws?.connected() && status !== 'working' && status !== 'thinking') {
        ws.send({ type: 'chat.history', threadKey: key } as any)
      }
    }
  }
  document.addEventListener('visibilitychange', onVisibility)
  unsubs.push(() => document.removeEventListener('visibilitychange', onVisibility))

  return () => {
    unsubs.forEach((u) => u())
    ws?.unsubscribe(['chat'])
    chatInitialized = false
  }
}

// Expose for testing
export { resetState as _resetState }
