// Pending indicator — shows local pending/failed sends when mounted

import { For, Show } from 'solid-js'
import { pendingQueue, retrySend, cancelFailedMessage, turns } from './store.js'
import type { PendingMessage } from './store.js'

export function QueueIndicator() {
  const failedMessages = () => pendingQueue().filter((m) => m.status === 'failed')
  const sendingMessages = () => pendingQueue().filter((m) => m.status === 'sending' || m.status === 'pending')

  return (
    <Show when={pendingQueue().length > 0}>
      <div
        class="flex flex-col gap-1 border-t px-4 py-2"
        style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
      >
        <For each={sendingMessages()}>
          {(item: PendingMessage) => (
            <div
              class="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
              style={{
                border: '1px dashed var(--c-border)',
                color: 'var(--c-text-muted)',
                opacity: '0.7'
              }}
            >
              <span class="min-w-0 flex-1 truncate">{item.text}</span>
              <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
                {item.status === 'sending' ? 'sending…' : `pending… (retry ${item.retries})`}
              </span>
            </div>
          )}
        </For>
        <For each={failedMessages()}>
          {(item: PendingMessage) => (
            <div
              class="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
              style={{
                border: '1px dashed var(--c-danger, #ef4444)',
                color: 'var(--c-danger, #ef4444)',
                opacity: '0.8'
              }}
            >
              <span class="min-w-0 flex-1 truncate">{item.text}</span>
              <button
                class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] hover:opacity-80"
                style={{
                  background: 'var(--c-bg-raised)',
                  border: '1px solid var(--c-border)',
                  color: 'var(--c-text-muted)'
                }}
                onClick={() => {
                  // Find the failed turn and retry
                  const failedTurn = turns().find((t) => t.role === 'user' && t.sendFailed && t.content === item.text)
                  if (failedTurn) retrySend(failedTurn)
                }}
                title="Retry sending"
              >
                ↻
              </button>
              <button
                class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] hover:opacity-80"
                style={{
                  background: 'var(--c-bg-raised)',
                  border: '1px solid var(--c-border)',
                  color: 'var(--c-text-muted)'
                }}
                onClick={() => {
                  const failedTurn = turns().find((t) => t.role === 'user' && t.sendFailed && t.content === item.text)
                  if (failedTurn) cancelFailedMessage(failedTurn)
                }}
                title="Discard message"
              >
                ✕
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
