// Header summary bubble — a small speech-bubble icon that opens a popup
// showing the rolling conversation summary for the presence gateway
// thread. Self-contained: owns its own open/close state and popup, unlike
// HealthPopover's button-in-Header split, since nothing else needs to
// drive it. The parent (Header.tsx) decides WHEN to render this component
// at all (gateway thread only) — this component only decides its own
// opacity and popup contents.

import { createSignal, onMount, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { summary, hasSummary } from './summary-store.js'

export function SummaryBubble() {
  const [open, setOpen] = createSignal(false)
  let bubbleRef: HTMLButtonElement | undefined
  let popupRef: HTMLDivElement | undefined

  function handleClickOutside(e: MouseEvent) {
    if (popupRef && !popupRef.contains(e.target as Node) && !bubbleRef?.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  onMount(() => document.addEventListener('mousedown', handleClickOutside))
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside))

  return (
    <>
      <button
        ref={bubbleRef}
        class="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-none bg-transparent transition-opacity"
        style={{ opacity: hasSummary() ? 0.7 : 0.4, color: 'var(--c-text)' }}
        onClick={() => setOpen(!open())}
        title={hasSummary() ? 'Conversation summary' : 'No summary yet'}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={popupRef}
            class="fixed z-[999] rounded-lg border p-3 shadow-lg"
            style={{
              background: 'var(--c-bg-raised)',
              'border-color': 'var(--c-border)',
              'max-width': '320px',
              top: '44px',
              right: '80px'
            }}
          >
            <div
              class="mb-2 text-xs font-semibold tracking-wide uppercase opacity-60"
              style={{ color: 'var(--c-text)' }}
            >
              Conversation Summary
            </div>
            <Show
              when={hasSummary()}
              fallback={
                <p class="text-[13px] leading-relaxed" style={{ color: 'var(--c-text-muted)' }}>
                  Hex has not built a summary for this conversation yet.
                </p>
              }
            >
              <p class="text-[13px] leading-relaxed" style={{ color: 'var(--c-text-muted)' }}>
                {summary()}
              </p>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  )
}
