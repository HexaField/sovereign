// §2.3 GlobalChat — Compact chat panel for _global main thread on dashboard
// Self-contained: fetches messages independently so it works even when no workspace is open

import { createSignal } from 'solid-js'
import type { ParsedTurn } from '@sovereign/core'

export const GLOBAL_CHAT_MESSAGE_LIMIT = 5
export const GLOBAL_CHAT_TRUNCATE_LENGTH = 120

export function truncateMessage(text: string, maxLen: number = GLOBAL_CHAT_TRUNCATE_LENGTH): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '…'
}

export function getLastMessages(turns: ParsedTurn[], limit: number = GLOBAL_CHAT_MESSAGE_LIMIT): ParsedTurn[] {
  return turns.slice(-limit)
}

export function formatRole(role: string): string {
  return role === 'user' ? 'You' : 'Agent'
}

import { setActiveWorkspace } from '../workspace/store'
import { setActiveView } from '../nav/store'

export function navigateToGlobalChat(): void {
  setActiveWorkspace('_global', 'Global')
  setActiveView('workspace')
}

import { turns as sharedTurns, agentStatus, sendMessage } from '../chat/store'

export default function GlobalChat() {
  // Show the last N messages from whatever thread the chat store is connected to.
  // On dashboard, the active thread defaults to 'main' (the global thread).
  const lastMessages = () => getLastMessages(sharedTurns(), GLOBAL_CHAT_MESSAGE_LIMIT)

  let inputRef: HTMLInputElement | undefined

  const handleSend = () => {
    const text = inputRef?.value?.trim()
    if (!text) return
    sendMessage(text)
    if (inputRef) inputRef.value = ''
  }

  return (
    <div
      class="flex flex-col rounded-lg border"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)',
        'border-radius': '8px'
      }}
    >
      <button
        class="flex cursor-pointer items-center justify-between border-b p-3 hover:brightness-110"
        style={{ 'border-color': 'var(--c-border)' }}
        onClick={navigateToGlobalChat}
      >
        <span class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Global Chat
        </span>
        <span class="text-xs opacity-60" style={{ color: 'var(--c-text)' }}>
          {agentStatus() !== 'idle' ? `Agent: ${agentStatus()}` : ''}
        </span>
      </button>
      <div class="max-h-48 flex-1 space-y-2 overflow-y-auto p-3">
        {lastMessages().map((turn) => (
          <div class="text-xs" style={{ color: 'var(--c-text)' }}>
            <span class="font-medium opacity-80">{formatRole(turn.role)}: </span>
            <span class="opacity-70">{truncateMessage(turn.content || '')}</span>
          </div>
        ))}
        {lastMessages().length === 0 && (
          <p class="text-xs opacity-40" style={{ color: 'var(--c-text)' }}>
            No messages yet
          </p>
        )}
      </div>
      <div class="flex gap-2 border-t p-3" style={{ 'border-color': 'var(--c-border)' }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Message _global..."
          class="flex-1 rounded border px-2 py-1 text-xs outline-none"
          style={{
            background: 'var(--c-bg)',
            color: 'var(--c-text)',
            'border-color': 'var(--c-border)'
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        />
        <button
          class="rounded px-3 py-1 text-xs font-medium"
          style={{ background: 'var(--c-accent)', color: 'white' }}
          onClick={handleSend}
        >
          Send
        </button>
      </div>
    </div>
  )
}
