// Per-thread actions (Pin / Rename / Archive) shared by every thread list.
//
// One controller per list holds which row's menu is open, which row awaits
// delete confirmation and which row is renaming — keyed by thread id, so the
// state survives a list that re-renders its rows (a polled list remounts them).
// The components that draw it live in ThreadActions.tsx.

import { createSignal } from 'solid-js'
import { deleteThread, pinThread, renameThread } from './store.js'

export interface ThreadActionsOptions {
  /** Deletes a thread. Defaults to the store's `deleteThread`. */
  remove?: (id: string) => Promise<void>
  /** Renames a thread. Defaults to the store's `renameThread`. */
  rename?: (id: string, label: string) => Promise<void>
  /** Pins or unpins a thread and resolves to its new `pinnedAt`. Defaults to the store's `pinThread`. */
  pin?: (id: string, pinned: boolean) => Promise<number | undefined>
  /** Runs after a delete succeeds — for lists that keep their own copy of the threads. */
  onDeleted?: (id: string) => void
  /** Runs after a rename succeeds. */
  onRenamed?: (id: string, label: string) => void
  /** Runs after a pin or unpin succeeds, with the server's `pinnedAt` (undefined once unpinned). */
  onPinned?: (id: string, pinnedAt: number | undefined) => void
}

export function createThreadActions(opts: ThreadActionsOptions = {}) {
  const remove = opts.remove ?? deleteThread
  const rename = opts.rename ?? renameThread
  const pin = opts.pin ?? pinThread

  const [menuKey, setMenuKey] = createSignal<string | null>(null)
  const [confirmKey, setConfirmKey] = createSignal<string | null>(null)
  const [renamingKey, setRenamingKey] = createSignal<string | null>(null)
  const [deletingKey, setDeletingKey] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')

  const closeMenu = () => {
    setMenuKey(null)
    setConfirmKey(null)
    setError('')
  }

  const openMenu = (id: string) => {
    closeMenu()
    setRenamingKey(null)
    setMenuKey(id)
  }

  return {
    menuKey,
    confirmKey,
    renamingKey,
    deletingKey,
    error,
    isMenuOpen: (id: string) => menuKey() === id,
    isConfirming: (id: string) => confirmKey() === id,
    isRenaming: (id: string) => renamingKey() === id,
    isDeleting: (id: string) => deletingKey() === id,
    /** True while any menu or rename field is open — polled lists hold their refresh. */
    busy: () => menuKey() !== null || renamingKey() !== null,
    openMenu,
    closeMenu,
    toggleMenu(id: string) {
      if (menuKey() === id) closeMenu()
      else openMenu(id)
    },
    /** Right-click on a row opens its menu instead of the browser's. */
    onContextMenu(id: string, e: MouseEvent) {
      if (renamingKey() === id) return // keep the native menu (paste) in the rename field
      e.preventDefault()
      e.stopPropagation()
      openMenu(id)
    },
    askDelete(id: string) {
      setError('')
      setMenuKey(id)
      setConfirmKey(id)
    },
    async confirmDelete(id: string): Promise<boolean> {
      if (deletingKey()) return false
      setDeletingKey(id)
      setError('')
      try {
        await remove(id)
        closeMenu()
        opts.onDeleted?.(id)
        return true
      } catch (err) {
        setError((err as Error).message || 'Archive failed')
        return false
      } finally {
        setDeletingKey(null)
      }
    },
    /** Pin to top / Unpin: closes the menu, then applies; an error reopens it with the message. */
    async togglePin(id: string, pinned: boolean): Promise<boolean> {
      closeMenu()
      try {
        const pinnedAt = await pin(id, pinned)
        opts.onPinned?.(id, pinnedAt)
        return true
      } catch (err) {
        setMenuKey(id)
        setError((err as Error).message || (pinned ? 'Pin failed' : 'Unpin failed'))
        return false
      }
    },
    startRename(id: string) {
      closeMenu()
      setRenamingKey(id)
    },
    stopRename() {
      setRenamingKey(null)
    },
    async saveRename(id: string, label: string): Promise<void> {
      await rename(id, label)
      opts.onRenamed?.(id, label)
    }
  }
}

export type ThreadActions = ReturnType<typeof createThreadActions>
