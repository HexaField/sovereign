// §R.8 Connection loss banner — shows when SSE/WS connection is interrupted

import { Show } from 'solid-js'
import { connectionLost } from './store.js'

export function ConnectionLossBanner() {
  return (
    <Show when={connectionLost()}>
      <div
        class="flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium"
        style={{
          background: 'var(--c-amber-bg, #fef3c7)',
          color: 'var(--c-amber, #92400e)',
          'border-bottom': '1px solid var(--c-amber-border, #fde68a)'
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        Connection lost — reconnecting…
      </div>
    </Show>
  )
}
