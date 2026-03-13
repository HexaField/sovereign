import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { ParsedTurn, WorkItem, AgentStatus } from '@template/core'

export const [turns, _setTurns] = createSignal<ParsedTurn[]>([])
export const [streamingHtml, _setStreamingHtml] = createSignal('')
export const [agentStatus, _setAgentStatus] = createSignal<AgentStatus>('idle')
export const [liveWork, _setLiveWork] = createSignal<WorkItem[]>([])
export const [liveThinkingText, _setLiveThinkingText] = createSignal('')
export const [compacting, _setCompacting] = createSignal(false)
export const [isRetryCountdownActive, _setRetryActive] = createSignal(false)
export const [retryCountdownSeconds, _setRetrySeconds] = createSignal(0)

export function sendMessage(_text: string, _attachments?: File[]): void {
  throw new Error('not implemented')
}

export function abortChat(): void {
  throw new Error('not implemented')
}

export function startRetryCountdown(_seconds: number): void {
  throw new Error('not implemented')
}

export function clearRetryCountdown(): void {
  throw new Error('not implemented')
}

export function initChatStore(_threadKey: Accessor<string>): void {
  throw new Error('not implemented')
}
