// §2.3 GlobalChat — Compact chat panel hardwired to the main thread
// Self-contained: fetches preview messages from /api/threads/main/preview-messages

import { createSignal, onMount } from 'solid-js'
import { setActiveWorkspace } from '../workspace/store.js'
import { setActiveView } from '../nav/store.js'

export const GLOBAL_CHAT_MESSAGE_LIMIT = 5
export const GLOBAL_CHAT_TRUNCATE_LENGTH = 120

export function truncateMessage(text: string, maxLen: number = GLOBAL_CHAT_TRUNCATE_LENGTH): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen).trimEnd() + '…'
}

export function formatRole(role: string): string {
  return role === 'user' ? 'You' : 'Agent'
}

export function navigateToGlobalChat(): void {
  setActiveWorkspace('_global', 'Global')
  setActiveView('workspace')
}

interface PreviewMessage {
  role: string
  content: string
}

export default function GlobalChat() {
  const [messages, setMessages] = createSignal<PreviewMessage[]>([])
  const [status, setStatus] = createSignal('idle')

  onMount(async () => {
    try {
      const res = await fetch('/api/threads/main/preview-messages')
      if (res.ok) {
        const data = await res.json()
        setMessages(data.messages ?? [])
        setStatus(data.agentStatus ?? 'idle')
      }
    } catch { /* ignore */ }
  })

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
          Main Thread
        </span>
        <span class="text-xs opacity-60" style={{ color: 'var(--c-text)' }}>
          {status() !== 'idle' ? `Agent: ${status()}` : ''}
        </span>
      </button>
      <div class="max-h-48 flex-1 space-y-2 overflow-y-auto p-3">
        {messages().map((msg) => (
          <div class="text-xs" style={{ color: 'var(--c-text)' }}>
            <span class="font-medium opacity-80">{formatRole(msg.role)}: </span>
            <span class="opacity-70">{truncateMessage(msg.content)}</span>
          </div>
        ))}
        {messages().length === 0 && (
          <p class="text-xs opacity-40" style={{ color: 'var(--c-text)' }}>
            No messages yet
          </p>
        )}
      </div>
    </div>
  )
}
