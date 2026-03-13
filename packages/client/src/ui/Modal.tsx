import { Show, onCleanup, onMount, createEffect } from 'solid-js'
import type { Accessor, JSX } from 'solid-js'

export function Modal(props: { open: Accessor<boolean>; onClose: () => void; title?: string; children?: JSX.Element }) {
  let dialogRef: HTMLDialogElement | undefined
  let previousFocus: HTMLElement | null = null

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
      return
    }
    // Focus trap
    if (e.key === 'Tab' && dialogRef) {
      const focusable = dialogRef.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === dialogRef) {
      props.onClose()
    }
  }

  createEffect(() => {
    if (props.open()) {
      previousFocus = document.activeElement as HTMLElement | null
      dialogRef?.showModal()
      // Focus first focusable element inside
      const first = dialogRef?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
      first?.focus()
    } else {
      dialogRef?.close()
      previousFocus?.focus()
    }
  })

  onMount(() => {
    dialogRef?.addEventListener('keydown', onKeyDown)
    dialogRef?.addEventListener('click', onBackdropClick)
  })

  onCleanup(() => {
    dialogRef?.removeEventListener('keydown', onKeyDown)
    dialogRef?.removeEventListener('click', onBackdropClick)
  })

  return (
    <dialog
      ref={dialogRef}
      class="rounded-lg border p-0 backdrop:bg-transparent"
      style={
        {
          background: 'var(--c-overlay-bg)',
          'border-color': 'var(--c-border)'
        } as any
      }
    >
      <div class="fixed inset-0" style={{ background: 'var(--c-backdrop)' }} />
      <div class="relative z-10 min-w-[300px] p-6">
        <Show when={props.title}>
          <h2 class="mb-4 text-lg font-semibold" style={{ color: 'var(--c-text-heading)' }}>
            {props.title}
          </h2>
        </Show>
        {props.children}
      </div>
    </dialog>
  )
}
