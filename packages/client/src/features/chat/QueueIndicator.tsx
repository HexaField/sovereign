import { createSignal, createEffect, createMemo, For, Show } from 'solid-js'
import { serverQueue, cancelQueuedMessage, retryQueuedMessage, forceSendQueuedMessage } from './store.js'

/**
 * Collapsed queue indicator that sits between the message list and the
 * input area. Shows only actionable items — 'queued' and 'failed'.
 *
 * Items in 'sending' status have already been accepted by the backend
 * and offer no user actions (force-send/remove buttons are disabled for
 * them). Hiding them avoids the visual overlap where a message appears
 * in chat history (via the synthetic user turn) while the indicator
 * still shows "sending…".
 *
 * Auto-expands when new actionable items arrive. Auto-collapses when
 * no actionable items remain.
 */
export function QueueIndicator() {
  const [expanded, setExpanded] = createSignal(false)
  let prevLength = 0

  // Only show items the user can act on — 'queued' and 'failed'.
  // 'sending' items have been handed to the backend; the agent status
  // indicator (thinking/working) provides feedback from that point.
  const actionableItems = createMemo(() => serverQueue().filter((m) => m.status !== 'sending'))

  // Auto-expand when new actionable items arrive; auto-collapse when none remain.
  createEffect(() => {
    const len = actionableItems().length
    if (len === 0) {
      setExpanded(false)
    } else if (len > prevLength) {
      setExpanded(true)
    }
    prevLength = len
  })

  return (
    <Show when={actionableItems().length > 0}>
      <div
        class="mx-auto w-full"
        style={{
          'border-top': '1px solid var(--c-border)',
          background: 'var(--c-bg)',
          'max-width': '48rem'
        }}
      >
        {/* Collapsed toggle */}
        <button
          class="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-4 py-2 text-left transition-colors"
          style={{ color: 'var(--c-text-muted)' }}
          onClick={() => setExpanded(!expanded())}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg, rgba(255,255,255,0.04))')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span
            class="flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold"
            style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
          >
            {actionableItems().length}
          </span>
          <span class="flex-1 text-xs">queued</span>
          <span
            class="text-[10px] transition-transform"
            style={{ transform: expanded() ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            ▾
          </span>
        </button>

        {/* Expanded list */}
        <Show when={expanded()}>
          <div
            class="flex max-h-48 flex-col gap-1 overflow-y-auto px-3 pb-2"
            style={{ 'border-top': '1px solid var(--c-border)' }}
          >
            <For each={actionableItems()}>
              {(item) => (
                <div
                  class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
                  style={{
                    background: 'var(--c-bg-raised)',
                    border:
                      item.status === 'failed'
                        ? '1px solid color-mix(in srgb, #ef4444 50%, transparent)'
                        : '1px solid var(--c-border)',
                    opacity: item.status === 'failed' ? '0.8' : '1'
                  }}
                >
                  {/* Message preview */}
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-xs" style={{ color: 'var(--c-text)', 'max-width': '100%' }}>
                      {item.text}
                    </div>
                    <Show when={item.status === 'failed'}>
                      <div class="mt-0.5 text-[10px]" style={{ color: '#ef4444' }}>
                        failed{item.error ? `: ${item.error.slice(0, 50)}` : ''}
                      </div>
                    </Show>
                  </div>

                  {/* Actions */}
                  <div class="flex shrink-0 items-center gap-1">
                    {/* Retry (failed only) */}
                    <Show when={item.status === 'failed'}>
                      <button
                        class="flex h-6 w-6 cursor-pointer items-center justify-center rounded border-none text-xs transition-colors"
                        style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--c-text-muted)' }}
                        onClick={() => retryQueuedMessage(item.id)}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                        title="Retry"
                      >
                        ↻
                      </button>
                    </Show>

                    {/* Force-send — inject mid-turn */}
                    <button
                      class="flex h-6 cursor-pointer items-center gap-0.5 rounded border-none px-1.5 text-[11px] font-medium transition-colors"
                      style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
                      onClick={() => forceSendQueuedMessage(item.id)}
                      onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.85')}
                      onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
                      title="Send now — inject into active conversation"
                    >
                      ⚡
                    </button>

                    {/* Remove */}
                    <button
                      class="flex h-6 w-6 cursor-pointer items-center justify-center rounded border-none text-xs transition-colors"
                      style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--c-text-muted)' }}
                      onClick={() => cancelQueuedMessage(item.id)}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.15)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
