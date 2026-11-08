// A bottom sheet for the phone layout: a dimmed backdrop (a tap closes it),
// a title row with a 40 px close button, and a scrolling body. Portalled, so
// it sits above the app chrome (the header is z-[100]).

import { onCleanup, onMount, type Component, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'

export interface MobileSheetProps {
  title: string
  onClose: () => void
  children: JSX.Element
  /** Taller sheets (the Filters sheet) take most of the screen; the default fits its content. */
  tall?: boolean
  testid?: string
}

const MobileSheet: Component<MobileSheetProps> = (props) => {
  onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        props.onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    onCleanup(() => document.removeEventListener('keydown', onKey, true))
  })
  return (
    <Portal>
      <div
        class="fixed inset-0 z-[120] flex flex-col justify-end"
        style={{ background: 'rgba(0,0,0,0.45)' }}
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
        data-testid={props.testid}
      >
        <div
          class="flex w-full flex-col rounded-t-xl border-t shadow-xl"
          classList={{ 'h-[88dvh]': props.tall, 'max-h-[88dvh]': !props.tall }}
          style={{
            background: 'var(--c-bg-raised)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)',
            'padding-bottom': 'env(safe-area-inset-bottom)'
          }}
        >
          <div class="flex items-center gap-2 border-b pl-4" style={{ 'border-color': 'var(--c-border)' }}>
            <span class="flex-1 text-sm font-semibold">{props.title}</span>
            <button
              class="flex h-11 w-11 items-center justify-center text-lg"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={() => props.onClose()}
              aria-label="Close"
              title="Close"
              data-testid="forge-sheet-close"
            >
              ✕
            </button>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
        </div>
      </div>
    </Portal>
  )
}

export default MobileSheet
