// Queue indicator — shows queued messages waiting to be sent to the agent

import { For, Show } from 'solid-js'
import type { QueuedMessage } from '@sovereign/core'
import { messageQueue, cancelMessage } from './store.js'

export function QueueIndicator() {
  return (
    <Show when={messageQueue().length > 0}>
      <div
        class="flex flex-col gap-1 border-t px-4 py-2"
        style={{ 'border-color': 'var(--c-border)', background: 'var(--c-bg)' }}
      >
        <For each={messageQueue()}>
          {(item: QueuedMessage) => (
            <div
              class="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
              style={{
                border: '1px dashed var(--c-border)',
                color: 'var(--c-text-muted)',
                opacity: item.status === 'sending' ? '0.7' : '0.5'
              }}
            >
              <span class="min-w-0 flex-1 truncate">{item.text}</span>
              {item.status === 'queued' ? (
                <button
                  class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[10px] hover:opacity-80"
                  style={{
                    background: 'var(--c-bg-raised)',
                    border: '1px solid var(--c-border)',
                    color: 'var(--c-text-muted)'
                  }}
                  onClick={() => cancelMessage(item.id)}
                  title="Cancel queued message"
                >
                  x
                </button>
              ) : (
                <span
                  class="shrink-0 text-[10px]"
                  style={{ color: 'var(--c-text-muted)' }}
                >
                  sending...
                </span>
              )}
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
