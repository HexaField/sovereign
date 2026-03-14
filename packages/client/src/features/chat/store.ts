import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ParsedTurn, WorkItem, AgentStatus } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'

export const [turns, setTurns] = createSignal<ParsedTurn[]>([])
export const [streamingHtml, setStreamingHtml] = createSignal('')
export const [agentStatus, setAgentStatus] = createSignal<AgentStatus>('idle')
export const [liveWork, setLiveWork] = createSignal<WorkItem[]>([])
export const [liveThinkingText, setLiveThinkingText] = createSignal('')
export const [compacting, setCompacting] = createSignal(false)
export const [isRetryCountdownActive, setRetryActive] = createSignal(false)
export const [retryCountdownSeconds, setRetrySeconds] = createSignal(0)
export const [inputValue, setInputValue] = createSignal('')

let retryTimer: ReturnType<typeof setInterval> | null = null
let ws: WsStore | null = null

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
  setAgentStatus('idle')
  setLiveWork([])
  setLiveThinkingText('')
  setCompacting(false)
  clearRetryCountdown()
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
  ws?.send({ type: 'chat.send', text })
}

export function abortChat(): void {
  ws?.send({ type: 'chat.abort' })
  setAgentStatus('idle')
}

export function initChatStore(_threadKey: Accessor<string>, wsStore?: WsStore): (() => void) | void {
  ws = wsStore ?? null
  if (!ws) return

  const unsubs: Array<() => void> = []

  unsubs.push(
    ws.on('chat.stream', (msg: any) => {
      setStreamingHtml((prev) => prev + msg.text)
    })
  )

  unsubs.push(
    ws.on('chat.turn', (msg: any) => {
      const turn = msg.turn as ParsedTurn
      // Replace optimistic pending turn if present
      setTurns((prev) => {
        const idx = prev.findIndex((t) => t.pending && t.role === 'user')
        if (turn.role === 'user' && idx >= 0) {
          const copy = [...prev]
          copy[idx] = turn
          return copy
        }
        return [...prev, turn]
      })
      setStreamingHtml('')
      setLiveWork([])
      setLiveThinkingText('')
    })
  )

  unsubs.push(
    ws.on('chat.status', (msg: any) => {
      setAgentStatus(msg.status)
    })
  )

  unsubs.push(
    ws.on('chat.work', (msg: any) => {
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
      setTurns(msg.history ?? [])
    })
  )

  // Return cleanup
  return () => {
    unsubs.forEach((u) => u())
  }
}

// Expose for testing
export { resetState as _resetState }
