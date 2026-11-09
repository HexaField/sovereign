// Per-thread actions (Pin / Rename / Archive) shared by every thread list.
//
// One controller per list holds which row's menu is open, which row awaits
// delete confirmation and which row is renaming — keyed by thread id, so the
// state survives a list that re-renders its rows (a polled list remounts them).
// The components that draw it live in ThreadActions.tsx.

import { createSignal } from 'solid-js'
import { createFolder, deleteThread, folders, moveThreadToFolder, pinThread, renameThread } from './store.js'
import { sortFolders, type FolderLike } from './thread-folders.js'

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
  /** Files a thread in a folder, or (`null`) takes it out. Defaults to the store's `moveThreadToFolder`. */
  move?: (id: string, folderId: string | null) => Promise<void>
  /** Makes a folder. Defaults to the store's `createFolder`. */
  makeFolder?: (name: string) => Promise<FolderLike>
  /** The folders to offer. Defaults to the store's `folders`. */
  folderList?: () => readonly FolderLike[]
  /** Runs when a move starts (it applies at once) — for lists that keep their own copy of the threads. */
  onMoved?: (id: string, folderId: string | null) => void
}

export function createThreadActions(opts: ThreadActionsOptions = {}) {
  const remove = opts.remove ?? deleteThread
  const rename = opts.rename ?? renameThread
  const pin = opts.pin ?? pinThread
  const move = opts.move ?? moveThreadToFolder
  const makeFolder = opts.makeFolder ?? createFolder
  const folderList = opts.folderList ?? folders

  const [menuKey, setMenuKey] = createSignal<string | null>(null)
  const [confirmKey, setConfirmKey] = createSignal<string | null>(null)
  const [pickingKey, setPickingKey] = createSignal<string | null>(null)
  const [renamingKey, setRenamingKey] = createSignal<string | null>(null)
  const [deletingKey, setDeletingKey] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')

  const closeMenu = () => {
    setMenuKey(null)
    setConfirmKey(null)
    setPickingKey(null)
    setError('')
  }

  /** Move, closing the menu; an error reopens it on the folder list with the message. */
  async function moveTo(id: string, folderId: string | null): Promise<boolean> {
    closeMenu()
    opts.onMoved?.(id, folderId)
    try {
      await move(id, folderId)
      return true
    } catch (err) {
      setMenuKey(id)
      setPickingKey(id)
      setError((err as Error).message || 'Move failed')
      return false
    }
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
    /** True while the menu shows the folder list ("Move to folder…"). */
    isPicking: (id: string) => pickingKey() === id,
    /** The folders a thread can move to, by name. */
    folderChoices: (current?: string | null) => sortFolders(folderList()).filter((f) => f.id !== current),
    /** "Move to folder…": show the folder list in the menu. */
    startPick(id: string) {
      setError('')
      setMenuKey(id)
      setConfirmKey(null)
      setPickingKey(id)
    },
    moveTo,
    /** Make a folder named `name` and file the thread in it. The menu stays open with the reason on failure. */
    async moveToNew(id: string, name: string): Promise<boolean> {
      setError('')
      let folder: FolderLike
      try {
        folder = await makeFolder(name)
      } catch (err) {
        setError((err as Error).message || 'Could not make the folder')
        return false
      }
      return moveTo(id, folder.id)
    },
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
      setPickingKey(null)
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
