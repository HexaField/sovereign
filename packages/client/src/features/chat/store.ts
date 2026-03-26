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

// Kept for backward compat — these are now derived from the streaming turn in turns[]
// but some ChatView code may still reference them during transition
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

// ── Helpers for the in-progress streaming turn ──────────────

/** Find the streaming turn index, or -1 */
function findStreamingTurnIndex(list: ParsedTurn[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].streaming) return i
  }
  return -1
}

/** Ensure a streaming assistant turn exists at the end of turns[].
 *  Returns the updated array. */
function ensureStreamingTurn(prev: ParsedTurn[]): ParsedTurn[] {
  const idx = findStreamingTurnIndex(prev)
  if (idx >= 0) return prev // Already exists
  return [
    ...prev,
    {
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      workItems: [],
      thinkingBlocks: [],
      streaming: true
    }
  ]
}

/** Update the streaming turn in-place (immutably). */
function updateStreamingTurn(prev: ParsedTurn[], updater: (turn: ParsedTurn) => ParsedTurn): ParsedTurn[] {
  const idx = findStreamingTurnIndex(prev)
  if (idx < 0) return prev
  const next = [...prev]
  next[idx] = updater(next[idx])
  return next
}

/** Remove the streaming turn. */
function removeStreamingTurn(prev: ParsedTurn[]): ParsedTurn[] {
  return prev.filter((t) => !t.streaming)
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
  streamingRawText = ''
  setAgentStatus('idle')
  setStreamingHtml('')
  setLiveWork([])
  setLiveThinkingText('')
  setCompacting(false)
  clearRetryCountdown()
  stopDurationTimer()
  suppressLifecycleUntil = 0
  setMessageQueue([])
  setHasOlderMessages(false)
  setLoadingOlder(false)
}

export function sendMessage(text: string, _attachments?: File[]): void {
  // Immediately add user turn so it's visible in the chat
  setTurns((prev) => [
    ...prev,
    {
      role: 'user' as const,
      content: text,
      timestamp: Date.now(),
      workItems: [],
      thinkingBlocks: []
    }
  ])
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
  // Remove the streaming turn and clear state
  setTurns((prev) => removeStreamingTurn(prev))
  streamingRawText = ''
  setStreamingHtml('')
  setLiveWork([])
  setLiveThinkingText('')
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

  streamingRawText = ''

  // ── chat.stream: update the streaming turn's content ──
  unsubs.push(
    ws.on('chat.stream', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return

      // Suppress for subagent threads
      const isSubagent = _threadKey().startsWith('subagent:')

      if (msg.replay) {
        streamingRawText = msg.text
      } else {
        streamingRawText += msg.text
      }

      const cleaned = cleanStreamText(streamingRawText)

      // Suppress partial sentinel strings
      const isSentinel = /^(NO_REPLY|HEARTBEAT_OK|NO_?|HEART)/.test(cleaned) && cleaned.length < 15

      if (cleaned && !isSubagent && !isSentinel) {
        // Ensure streaming turn exists, then update its content
        setTurns((prev) => {
          const withTurn = ensureStreamingTurn(prev)
          return updateStreamingTurn(withTurn, (t) => ({
            ...t,
            content: cleaned
          }))
        })
        // Keep legacy signal in sync for any ChatView code that still reads it
        setStreamingHtml(renderMarkdown(cleaned))
      } else if (isSubagent && cleaned) {
        setAgentStatus('working')
      }
    })
  )

  // ── chat.turn: replace streaming turn with final turn ──
  unsubs.push(
    ws.on('chat.turn', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const turn = msg.turn as ParsedTurn
      setTurns((prev) => {
        const without = removeStreamingTurn(prev)
        return [...without, turn]
      })
      streamingRawText = ''
      setStreamingHtml('')
      setLiveWork([])
      setLiveThinkingText('')
    })
  )

  // ── chat.status: track agent status, clear on idle ──
  unsubs.push(
    ws.on('chat.status', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      if (Date.now() < suppressLifecycleUntil && msg.status !== 'idle') return
      setAgentStatus(msg.status)
      if (msg.status === 'working' || msg.status === 'thinking') {
        if (!agentWorkingStartTime()) startDurationTimer()
      } else {
        stopDurationTimer()
        if (msg.status === 'idle') {
          // Agent done — remove any lingering streaming turn that wasn't finalized
          setTurns((prev) => removeStreamingTurn(prev))
          streamingRawText = ''
          setStreamingHtml('')
          setLiveWork([])
          setLiveThinkingText('')
        }
      }
    })
  )

  // ── chat.work: append work items to the streaming turn ──
  unsubs.push(
    ws.on('chat.work', (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      const work = msg.work as WorkItem

      // Update the streaming turn's workItems
      setTurns((prev) => {
        const withTurn = ensureStreamingTurn(prev)
        return updateStreamingTurn(withTurn, (t) => ({
          ...t,
          workItems: [...t.workItems, work]
        }))
      })

      // Keep legacy signals in sync
      setLiveWork((prev) => [...prev, work])
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
      streamingRawText = ''
      setStreamingHtml('')
      setLiveWork([])
      setLiveThinkingText('')
    })
  )

  // Queue updates
  unsubs.push(
    ws.on('chat.queue.update' as any, (msg: any) => {
      if (msg.threadKey && msg.threadKey !== _threadKey()) return
      setMessageQueue(msg.queue ?? [])
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
