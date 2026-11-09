// Folders in the thread lists (header picker, Overview): the folder block (its
// row and, when open, its threads), the "+ New folder" field, and the hub that
// lets every list's drag light up the folder it would drop into.
// Layout rule: thread-folders.ts. Drag behaviour: thread-drag-controller.ts.
//
//   const hub = createFolderDragHub()
//   const drag = createThreadDrag({ list: 'main', onMoveToFolder: moveThreadToFolder, … })
//   hub.add('main', drag)
//   <For each={layout().folders}>
//     {(f) => <FolderBlock folder={f} threads={() => layout().inFolder.get(f.id) ?? []} hub={hub} … />}
//   </For>

import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { createFolder, deleteFolder, isFolderOpen, renameFolder, toggleFolder, type ThreadFolder } from './store.js'
import { createThreadDrag, type ThreadDrag } from './thread-drag-controller.js'
import type { DragThread, ReorderPlan } from './thread-drag.js'
import { ThreadRenameInput } from './ThreadActions.js'

/** The drags of one container's lists, so a folder can show it is the drop target. */
export function createFolderDragHub() {
  const [drags, setDrags] = createSignal<ReadonlyArray<{ list: string; drag: ThreadDrag }>>([])
  return {
    /** Register a list's drag; returns the unregister function. */
    add(list: string, drag: ThreadDrag): () => void {
      const entry = { list, drag }
      setDrags((prev) => [...prev, entry])
      return () => setDrags((prev) => prev.filter((e) => e !== entry))
    },
    /** The folder move a drop would make now: from which list, into which folder (`null`: out of it). */
    move(): { list: string; to: string | null } | undefined {
      for (const { list, drag } of drags()) {
        if (!drag.draggingId()) continue
        const to = drag.folderTarget()
        return to === undefined ? undefined : { list, to }
      }
      return undefined
    }
  }
}

export type FolderDragHub = ReturnType<typeof createFolderDragHub>

/** Draws one thread row of a folder. The row must carry `data-thread-row` and `data-drag-list={folder id}`. */
export type FolderRow<T> = (
  thread: T,
  index: () => number,
  isLast: () => boolean,
  drag: ThreadDrag,
  folderId: string
) => JSX.Element

export function FolderBlock<T extends DragThread>(props: {
  folder: ThreadFolder
  /** The folder's threads, in order (what the list shows inside it). */
  threads: () => T[]
  /** The list's scrolling element. */
  container: () => HTMLElement | undefined
  hub: FolderDragHub
  onReorder: (plan: ReorderPlan) => void
  onMove: (id: string, folderId: string | null) => void
  row: FolderRow<T>
  /** Show the threads whatever the folder's open state (a search). */
  forceOpen?: () => boolean
  /** Extra classes for the folder's row. */
  rowClass?: string
}) {
  let block: HTMLDivElement | undefined
  const id = () => props.folder.id
  const drag = createThreadDrag<T>({
    items: () => props.threads(),
    container: props.container,
    list: props.folder.id,
    ownFolder: props.folder.id,
    section: () => block,
    onReorder: (plan) => props.onReorder(plan),
    onMoveToFolder: (tid, to) => props.onMove(tid, to)
  })
  const off = props.hub.add(props.folder.id, drag)
  onCleanup(() => {
    off()
    drag.dispose()
  })

  const open = () => isFolderOpen(id()) || !!props.forceOpen?.()
  const dropping = () => {
    const m = props.hub.move()
    return m?.to === id() && m.list !== id()
  }
  const leaving = () => {
    const m = props.hub.move()
    return m?.list === id() && m.to === null
  }

  const [menu, setMenu] = createSignal<'closed' | 'menu' | 'confirm'>('closed')
  const [renaming, setRenaming] = createSignal(false)
  const [error, setError] = createSignal('')
  const closeMenu = () => {
    setMenu('closed')
    setError('')
  }

  return (
    <div
      ref={(el) => (block = el)}
      data-drop-folder={props.folder.id}
      data-testid="thread-folder"
      class="rounded-md transition-colors"
      style={{
        background: dropping() ? 'var(--c-hover-bg-strong, var(--c-hover-bg))' : undefined,
        outline: dropping() ? '1px solid var(--c-accent)' : undefined
      }}
    >
      <div
        class={`group relative flex w-full items-center text-left text-sm ${props.rowClass ?? ''}`}
        style={{ color: 'var(--c-text)' }}
        onContextMenu={(e) => {
          if (renaming()) return
          e.preventDefault()
          e.stopPropagation()
          setMenu('menu')
        }}
      >
        <Show
          when={!renaming()}
          fallback={
            <div class="flex min-w-0 flex-1 px-2 py-1">
              <ThreadRenameInput
                initial={props.folder.name}
                label="Folder name"
                showError
                onSave={(name) => renameFolder(id(), name)}
                onDone={() => setRenaming(false)}
              />
            </div>
          }
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-none bg-transparent py-2 pr-1 pl-1.5 text-left"
            style={{ color: 'inherit' }}
            aria-expanded={open()}
            title={open() ? 'Close folder' : 'Open folder'}
            onClick={(e) => {
              e.stopPropagation()
              toggleFolder(id())
            }}
          >
            <span class="w-3 shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {open() ? '▾' : '▸'}
            </span>
            <span class="shrink-0">{open() ? '📂' : '📁'}</span>
            <span class="truncate font-medium">{props.folder.name}</span>
            <span class="shrink-0 text-[10px]" style={{ color: 'var(--c-text-muted)' }}>
              {props.threads().length}
            </span>
            <Show when={dropping()}>
              <span
                class="ml-auto shrink-0 rounded px-1 text-[9px] leading-[14px] font-semibold whitespace-nowrap"
                style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
              >
                Move here
              </span>
            </Show>
            <Show when={leaving()}>
              <span
                class="ml-auto shrink-0 rounded px-1 text-[9px] leading-[14px] font-semibold whitespace-nowrap"
                style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
              >
                Remove from folder
              </span>
            </Show>
          </button>
        </Show>
        <button
          type="button"
          data-thread-actions-button=""
          class="shrink-0 cursor-pointer rounded border-none bg-transparent px-2 py-1 text-sm font-bold opacity-70 transition-opacity hover:!opacity-100"
          style={{ color: 'var(--c-text-muted)' }}
          title="Rename or delete folder"
          aria-label="Folder actions"
          aria-haspopup="menu"
          aria-expanded={menu() !== 'closed'}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (menu() === 'closed') setMenu('menu')
            else closeMenu()
          }}
        >
          ⋯
        </button>
      </div>
      <Show when={menu() !== 'closed'}>
        <FolderMenu
          name={props.folder.name}
          count={props.threads().length}
          confirming={menu() === 'confirm'}
          error={error()}
          onClose={closeMenu}
          onRename={() => {
            closeMenu()
            setRenaming(true)
          }}
          onAskDelete={() => setMenu('confirm')}
          onDelete={() => {
            closeMenu()
            deleteFolder(id()).catch((err: Error) => {
              setMenu('menu')
              setError(err.message || 'Delete failed')
            })
          }}
        />
      </Show>
      <Show when={open()}>
        <div class="ml-3 border-l pl-0.5" style={{ 'border-color': 'var(--c-border)' }}>
          <Show
            when={props.threads().length > 0}
            fallback={
              <div class="px-3 py-1.5 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
                Empty — drag a chat here, or use ⋯ → Move to folder…
              </div>
            }
          >
            <For each={props.threads()}>
              {(t, i) => props.row(t, i, () => i() === props.threads().length - 1, drag, props.folder.id)}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function FolderMenu(props: {
  name: string
  count: number
  confirming: boolean
  error: string
  onClose: () => void
  onRename: () => void
  onAskDelete: () => void
  onDelete: () => void
}) {
  let panel: HTMLDivElement | undefined
  onMount(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null
      if (!target || panel?.contains(target) || target.closest?.('[data-thread-actions-button]')) return
      props.onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
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
      data-testid="folder-actions-menu"
      class="mx-2 mb-1 overflow-hidden rounded-md text-xs"
      style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <Show
        when={props.confirming}
        fallback={
          <>
            <button
              type="button"
              role="menuitem"
              class={itemClass}
              style={{ color: 'var(--c-text)' }}
              {...hover}
              onClick={() => props.onRename()}
            >
              Rename folder
            </button>
            <button
              type="button"
              role="menuitem"
              class={itemClass}
              style={{ color: '#ef4444' }}
              {...hover}
              onClick={() => props.onAskDelete()}
            >
              Delete folder
            </button>
          </>
        }
      >
        <div class="px-3 pt-2 pb-1.5" style={{ color: 'var(--c-text)' }}>
          Delete “{props.name}”?{' '}
          {props.count === 0
            ? 'It is empty.'
            : `Its ${props.count === 1 ? 'chat goes' : `${props.count} chats go`} back to the list — no chat is deleted.`}
        </div>
        <div class="flex justify-end gap-1 px-2 pb-2">
          <button
            type="button"
            class="cursor-pointer rounded bg-transparent px-2 py-1"
            style={{ color: 'var(--c-text)', border: '1px solid var(--c-border)' }}
            onClick={() => props.onClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="cursor-pointer rounded border-none px-2 py-1 font-medium text-white"
            style={{ background: '#ef4444' }}
            onClick={() => props.onDelete()}
            ref={(el) => setTimeout(() => el.focus(), 0)}
          >
            Delete folder
          </button>
        </div>
      </Show>
      <Show when={props.error}>
        <div class="px-3 pb-2" style={{ color: '#ef4444' }}>
          {props.error}
        </div>
      </Show>
    </div>
  )
}

/** "+ New folder": a button that turns into a name field; Enter makes the folder (opened). */
export function NewFolderButton(props: { class?: string; onCreated?: (folder: ThreadFolder) => void }) {
  const [naming, setNaming] = createSignal(false)
  return (
    <Show
      when={naming()}
      fallback={
        <button
          type="button"
          class={props.class ?? "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors"}
          style={{ color: 'var(--c-text-muted)' }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-hover-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          onClick={() => setNaming(true)}
        >
          + New folder
        </button>
      }
    >
      <div class="flex items-center px-2 py-1.5">
        <ThreadRenameInput
          initial=""
          label="New folder name"
          placeholder="Folder name (e.g. Dogs)…"
          showError
          onSave={async (name) => {
            const folder = await createFolder(name)
            props.onCreated?.(folder)
          }}
          onDone={() => setNaming(false)}
        />
      </div>
    </Show>
  )
}
