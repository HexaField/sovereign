// Header summary bubble — toggles between the full conversation and the
// simple conversation view (user messages + Hex's spoken replies) on
// the presence gateway thread. The icon highlights when the simple view
// is active.

import { toggleSimpleView, showSimpleView, simpleConversationEntries } from './simple-conversation-store.js'

export function SummaryBubble() {
  const hasEntries = () => simpleConversationEntries().length > 0
  const active = () => showSimpleView()

  return (
    <button
      class="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-none transition-opacity"
      style={{
        opacity: active() ? 1 : hasEntries() ? 0.7 : 0.4,
        color: active() ? '#fff' : 'var(--c-text)',
        background: active() ? 'var(--c-accent)' : 'transparent'
      }}
      onClick={() => toggleSimpleView()}
      title={active() ? 'Show full conversation' : 'Show simple conversation'}
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
  )
}
