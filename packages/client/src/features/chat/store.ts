import { createSignal, createEffect } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ParsedTurn, WorkItem, AgentStatus } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'
import { renderMarkdown, stripThinkingBlocks } from '../../lib/markdown.js'

export const [turns, setTurns] = createSignal<ParsedTurn[]>([])
export const [streamingHtml, setStreamingHtml] = createSignal('')
export const [agentStatus, setAgentStatus] = createSignal<AgentStatus>('idle')
export const [liveWork, setLiveWork] = createSignal<WorkItem[]>([])
export const [liveThinkingText, setLiveThinkingText] = createSignal('')
export const [compacting, setCompacting] = createSignal(false)
export const [isRetryCountdownActive, setRetryActive] = createSignal(false)
export const [retryCountdownSeconds, setRetrySeconds] = createSignal(0)
export const [inputValue, _setInputValue] = createSignal('')

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

let retryTimer: ReturnType<typeof setInterval> | null = null
let ws: WsStore | null = null
let suppressLifecycleUntil = 0
let currentThreadKey: Accessor<string> | null = null
let streamingRawText = ''
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

function resetState(): void {
  setTurns([])
  setStreamingHtml('')
  streamingRawText = ''
  streamTextOffset = 0
  setAgentStatus('idle')
  setLiveWork([])
  setLiveThinkingText('')
  setCompacting(false)
  clearRetryCountdown()
  suppressLifecycleUntil = 0
}

export function sendMessage(text: string, _attachments?: File[]): void {
  // Add optimistic pending turn
  const pending: ParsedTurn = {
    role: 'user',
    content: text,
    timestamp: Date.now(),
    workItems: [],
    thinkingBlocks: [],
    pending: true
  }
  setTurns((prev) => [...prev, pending])
  ws?.send({ type: 'chat.send', text, threadKey: currentThreadKey?.() ?? 'main' } as any)
}

export function abortChat(): void {
  ws?.send({ type: 'chat.abort', threadKey: currentThreadKey?.() ?? 'main' } as any)
  setAgentStatus('idle')
  setStreamingHtml('')
  streamingRawText = ''
  streamTextOffset = 0
  setLiveWork([])
  setLiveThinkingText('')
  // Suppress lifecycle status updates for 30s to prevent flicker
  suppressLifecycleUntil = Date.now() + 30_000
}

let chatInitialized = false
export function initChatStore(_threadKey: Accessor<string>, wsStore?: WsStore): (() => void) | void {
  ws = wsStore ?? null
  currentThreadKey = _threadKey
  if (!ws) return
  if (chatInitialized) return
  chatInitialized = true

  // Subscribe to chat channel (no scope filter — we filter by threadKey client-side)
  ws.subscribe(['chat'])

  // Request history for the current thread (skip if no thread selected)
  if (_threadKey()) {
    ws.send({ type: 'chat.history', threadKey: _threadKey() } as any)
    loadDraft(_threadKey())
  }

  // Track previous thread key to detect switches
  let prevThreadKey = _threadKey()

  const unsubs: Array<() => void> = []

  // Watch for thread switches — reset state and request new history
  // Note: createEffect must be called within a reactive owner (onMount provides one)
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

  // Reset streaming text for new init
  streamingRawText = ''

  unsubs.push(
    ws.on('chat.stream', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      // Replay messages contain full accumulated text — reset state
      if (msg.replay) {
        streamingRawText = msg.text
        streamTextOffset = 0
      } else {
        streamingRawText += msg.text
      }
      const cleaned = stripThinkingBlocks(streamingRawText)
        .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
        .trim()
      // Only show text generated AFTER the last tool call
      const visible = cleaned.substring(streamTextOffset).trim()
      // Suppress streaming bubble for subagent threads
      const isSubagent = _threadKey().startsWith('subagent:')
      const hasToolCalls = liveWork().some((w) => w.type === 'tool_call')
      // Suppress partial sentinel strings (NO_REPLY, HEARTBEAT_OK)
      const isSentinel = /^(NO_REPLY|HEARTBEAT_OK|NO_?|HEART)/.test(visible) && visible.length < 15
      if (visible && !hasToolCalls && !isSubagent && !isSentinel) {
        setStreamingHtml(renderMarkdown(visible))
      } else {
        setStreamingHtml('')
        if (isSubagent && visible) setAgentStatus('working')
      }
    })
  )

  unsubs.push(
    ws.on('chat.turn', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const turn = msg.turn as ParsedTurn
      // Replace optimistic pending turn if present
      setTurns((prev) => {
        const idx = prev.findIndex((t) => t.pending && t.role === 'user')
        let next: ParsedTurn[]
        if (turn.role === 'user' && idx >= 0) {
          next = [...prev]
          next[idx] = turn
        } else {
          next = [...prev, turn]
        }
        return next
      })
      setStreamingHtml('')
      streamingRawText = ''
      streamTextOffset = 0
      setLiveWork([])
      setLiveThinkingText('')
    })
  )

  unsubs.push(
    ws.on('chat.status', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      // Suppress lifecycle START updates after abort to prevent "Working…" flicker
      // But always allow idle/end events through
      if (Date.now() < suppressLifecycleUntil && msg.status !== 'idle') return
      setAgentStatus(msg.status)
    })
  )

  unsubs.push(
    ws.on('chat.work', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      // Reset streaming text offset on tool call to prevent accumulation
      if (msg.work?.type === 'tool_call') {
        const cleaned = stripThinkingBlocks(streamingRawText)
          .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
          .trim()
        streamTextOffset = cleaned.length
        setStreamingHtml('')
      }
      setLiveWork((prev) => [...prev, msg.work])
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

  unsubs.push(
    ws.on('chat.session.info', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const history: ParsedTurn[] = msg.history ?? []
      // Clean up legacy localStorage pending turns
      try {
        localStorage.removeItem(`sovereign:pending-turns:${_threadKey()}`)
      } catch {
        /* */
      }
      setTurns(history)
    })
  )

  // Return cleanup
  return () => {
    unsubs.forEach((u) => u())
    ws?.unsubscribe(['chat'])
  }
}

// Expose for testing
export { resetState as _resetState }
