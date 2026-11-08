// Thread actions UI shared by every thread list: the "⋯" button, the inline
// Pin / Rename / Archive menu (with delete confirmation), and the inline rename field.
// State lives in a `createThreadActions()` controller (thread-actions.ts).
//
// Usage in a list row:
//   <div onContextMenu={(e) => actions.onContextMenu(t.id, e)}>
//     <Show when={actions.isRenaming(t.id)} fallback={<Label />}>
//       <ThreadRenameInput initial={t.label} onSave={(l) => actions.saveRename(t.id, l)} onDone={actions.stopRename} />
//     </Show>
//     <ThreadActionsButton actions={actions} threadId={t.id} />
//   </div>
//   <ThreadActionsMenu actions={actions} thread={t} />

import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js'
import type { ThreadActions } from './thread-actions.js'
import { isPinned } from './thread-order.js'

/** The thread fields the menu reads. */
type MenuThread = { id: string; pinnedAt?: number | null }

/** The 📌 shown next to a pinned thread's name in every list. */
export function PinMark(props: { thread: { pinnedAt?: number | null }; class?: string }) {
  return (
    <Show when={isPinned(props.thread)}>
      <span class={props.class ?? "shrink-0 text-[10px] leading-none"} title="Pinned" aria-label="Pinned" role="img">
        📌
      </span>
    </Show>
  )
}

/** Marks the ⋯ buttons (`data-thread-actions-button`), so a press on one does not count as a click outside an open menu. */
const BUTTON_ATTR = 'data-thread-actions-button'

/** The "⋯" button that opens a thread's Pin / Rename / Archive menu. */
export function ThreadActionsButton(props: {
  actions: ThreadActions
  threadId: string
  /** Runs before the menu toggles — e.g. to close the list's other popovers. */
  onToggle?: () => void
  class?: string
  style?: JSX.CSSProperties
}) {
  return (
    <button
      type="button"
      data-thread-actions-button=""
      class={
        props.class ??
        "shrink-0 cursor-pointer rounded border-none bg-transparent px-2 py-1 text-sm font-bold opacity-70 transition-opacity hover:!opacity-100"
      }
      style={{ color: 'var(--c-text-muted)', ...props.style }}
      title="Pin, rename or archive"
      aria-label="Thread actions"
      aria-haspopup="menu"
      aria-expanded={props.actions.isMenuOpen(props.threadId)}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onToggle?.()
        props.actions.toggleMenu(props.threadId)
      }}
    >
      ⋯
    </button>
  )
}

/** The inline Pin / Rename / Archive menu for one thread; renders only while that thread's menu is open. */
export function ThreadActionsMenu(props: { actions: ThreadActions; thread: MenuThread; class?: string }) {
  return (
    <Show when={props.actions.isMenuOpen(props.thread.id)}>
      <MenuPanel actions={props.actions} thread={props.thread} class={props.class} />
    </Show>
  )
}

function MenuPanel(props: { actions: ThreadActions; thread: MenuThread; class?: string }) {
  let panel: HTMLDivElement | undefined
  const id = () => props.thread.id

  // Close on a press outside the menu (other than a ⋯ button) or on Escape.
  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target || panel?.contains(target)) return
      if (target.closest?.(`[${BUTTON_ATTR}]`)) return
      props.actions.closeMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.actions.closeMenu()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    })
  })

  const itemClass = 'flex w-full cursor-pointer items-center border-none bg-transparent px-3 py-1.5 text-left'
  const hover = {
    onMouseEnter: (e: MouseEvent) => ((e.currentTarget as HTMLElement).style.background = 'var(--c-hover-bg)'),
    onMouseLeave: (e: MouseEvent) => ((e.currentTarget as HTMLElement).style.background = '')
  }

  return (
    <div
      ref={(el) => (panel = el)}
      role="menu"
      data-testid="thread-actions-menu"
      class={props.class ?? "mx-2 mb-1 overflow-hidden rounded-md text-xs"}
      style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <Show
        when={props.actions.isConfirming(id())}
        fallback={
          <>
            <button
              type="button"
              role="menuitem"
              class={itemClass}
              style={{ color: 'var(--c-text)' }}
              {...hover}
              onClick={() => void props.actions.togglePin(id(), !isPinned(props.thread))}
            >
              {isPinned(props.thread) ? 'Unpin' : 'Pin to top'}
            </button>
            <button
              type="button"
              role="menuitem"
              class={itemClass}
              style={{ color: 'var(--c-text)' }}
              {...hover}
              onClick={() => props.actions.startRename(id())}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              class={itemClass}
              style={{ color: '#ef4444' }}
              {...hover}
              onClick={() => props.actions.askDelete(id())}
            >
              Archive
            </button>
          </>
        }
      >
        <div class="px-3 pt-2 pb-1.5" style={{ color: 'var(--c-text)' }}>
          Archive this thread? Its history is kept.
        </div>
        <div class="flex justify-end gap-1 px-2 pb-2">
          <button
            type="button"
            class="cursor-pointer rounded bg-transparent px-2 py-1"
            style={{ color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            onClick={() => props.actions.closeMenu()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="cursor-pointer rounded border-none px-2 py-1 font-medium text-white"
            style={{ background: '#ef4444', opacity: props.actions.isDeleting(id()) ? '0.5' : '1' }}
            disabled={props.actions.isDeleting(id())}
            onClick={() => void props.actions.confirmDelete(id())}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          >
            {props.actions.isDeleting(id()) ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </Show>
      <Show when={props.actions.error()}>
        <div class="px-3 pb-2" style={{ color: '#ef4444' }}>
          {props.actions.error()}
        </div>
      </Show>
    </div>
  )
}

/** Inline thread-name editor: Enter saves, Escape (or leaving the field) cancels. */
export function ThreadRenameInput(props: {
  initial: string
  onSave: (label: string) => Promise<void>
  onDone: () => void
  class?: string
}) {
  const [value, setValue] = createSignal(props.initial)
  const [error, setError] = createSignal('')
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    props.onDone()
  }
  const save = async () => {
    const label = value().trim()
    if (!label || label === props.initial) return finish()
    try {
      await props.onSave(label)
      finish()
    } catch (err) {
      setError((err as Error).message || 'Rename failed')
    }
  }
  return (
    <input
      class={props.class ?? "w-full min-w-0 rounded border px-2 py-1 text-xs outline-none"}
      style={{
        background: 'var(--c-bg)',
        'border-color': error() ? '#ef4444' : 'var(--c-accent)',
        color: 'var(--c-text)'
      }}
      aria-label="Thread name"
      title={error() || 'Enter to save, Escape to cancel'}
      value={value()}
      onInput={(e) => {
        setValue(e.currentTarget.value)
        setError('')
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          void save()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish()
        }
      }}
      onClick={(e) => e.stopPropagation()}
      onBlur={finish}
      ref={(el) =>
        setTimeout(() => {
          el.focus()
          el.select()
        }, 0)
      }
    />
  )
}
