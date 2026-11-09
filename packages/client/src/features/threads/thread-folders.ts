// User-made folders in the thread lists (header picker, Overview). One level:
// a folder holds threads, never other folders. The lists show, top to bottom:
//
//   1. pinned threads of the main list,
//   2. the folders, by name (A–Z), each holding its threads,
//   3. the other threads of the main list.
//
// A thread whose `folderId` names no known folder lists in the main list.
// Inside a folder, and in the main list, threads follow the thread-list order
// (thread-order.ts): pinned first, then never-placed, then the manual order.
// Each of these lists is dragged on its own; dropping a thread on a folder
// files it there, and dragging one out of its folder puts it back in the main list.

import { isPinned, sortThreads, type Listable, type Orderable } from './thread-order.js'

export interface FolderLike {
  id: string
  name: string
  createdAt?: number
}

/** The fields the layout reads. `folderId` arrives as `null` from a `thread.updated` that unfiles it. */
export interface Fileable extends Orderable, Listable {
  id: string
  folderId?: string | null
}

/** Folders in list order: by name, ignoring case and reading numbers as numbers. */
export function sortFolders<F extends FolderLike>(folders: readonly F[]): F[] {
  return [...folders].sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0)
  )
}

/** The folder a thread lists in, or undefined for the main list. */
export function folderOf(t: Fileable, known: ReadonlySet<string>): string | undefined {
  return t.folderId && known.has(t.folderId) ? t.folderId : undefined
}

export interface ListLayout<T, F> {
  /** The main list, in order: its pinned threads, then the rest. The folders show between the two. */
  main: T[]
  /** How many of `main` are pinned (shown above the folders). */
  pinnedCount: number
  /** The folders to show, in order. */
  folders: F[]
  /** Each shown folder's threads, in order. */
  inFolder: Map<string, T[]>
}

export interface LayoutFilter<T, F> {
  thread: (t: T) => boolean
  folder: (f: F) => boolean
}

/**
 * Lay out listed threads (already without archived and hidden ones) with the
 * folders. With a `filter` (a search): a thread shows when it matches or its
 * folder's name does, and a folder shows when its name or any of its threads
 * match. Without one, every folder shows, empty ones included.
 */
export function layoutThreads<T extends Fileable, F extends FolderLike>(
  threads: readonly T[],
  folders: readonly F[],
  filter?: LayoutFilter<T, F>
): ListLayout<T, F> {
  const known = new Set(folders.map((f) => f.id))
  const grouped = new Map<string, T[]>(folders.map((f) => [f.id, []]))
  const main: T[] = []
  for (const t of threads) {
    const id = folderOf(t, known)
    if (id) grouped.get(id)!.push(t)
    else if (!filter || filter.thread(t)) main.push(t)
  }
  const shown: F[] = []
  const inFolder = new Map<string, T[]>()
  for (const f of sortFolders(folders)) {
    const all = grouped.get(f.id)!
    const nameMatches = !filter || filter.folder(f)
    const members = nameMatches ? all : all.filter((t) => filter!.thread(t))
    if (filter && !nameMatches && members.length === 0) continue
    shown.push(f)
    inFolder.set(f.id, sortThreads(members))
  }
  const sortedMain = sortThreads(main)
  return {
    main: sortedMain,
    pinnedCount: sortedMain.filter(isPinned).length,
    folders: shown,
    inFolder
  }
}

/** Which folders are open, by id. Kept per browser (localStorage). */
const OPEN_KEY = 'sovereign:openThreadFolders'

export function loadOpenFolders(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(OPEN_KEY)
    const ids = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function saveOpenFolders(open: ReadonlySet<string>): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify([...open]))
  } catch {
    /* private mode or full: folders just start closed next time */
  }
}
