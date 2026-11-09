import { createSignal, createMemo, onMount, onCleanup, Show, For } from 'solid-js'
import { wsStore } from '../../ws/index.js'
import { threadKey, setThreadKey, reorderThreads, folders, moveThreadToFolder } from '../threads/store.js'
import { closeDashboardModal } from '../nav/store.js'
import { createThreadActions } from '../threads/thread-actions.js'
import { PinMark, ThreadActionsButton, ThreadActionsMenu, ThreadRenameInput } from '../threads/ThreadActions.js'
import { isListed, sortThreads } from '../threads/thread-order.js'
import { layoutThreads } from '../threads/thread-folders.js'
import { createFolderDragHub, FolderBlock, NewFolderButton } from '../threads/ThreadFolders.js'
import { applyReorder, restoreOrder, snapshotOrder, type ReorderPlan } from '../threads/thread-drag.js'
import { createThreadDrag, type ThreadDrag } from '../threads/thread-drag-controller.js'
import { DragGrip, DropLine } from '../threads/ThreadDrag.js'

export interface ThreadEntry {
  id: string
  label: string
  membraneId?: string
  agentStatus: string
  lastActivity: number
  archived: boolean
  /** The presence role (`gateway` or `internal`), when the thread holds one. */
  presence?: string
  /** Set while pinned to the top; `null` after an unpin broadcast. */
  pinnedAt?: number | null
  /** The thread's manual place (drag to reorder); `null` after a broadcast that drops it. */
  sortOrder?: number | null
  /** The folder it is filed in; `null` after a broadcast that takes it out. */
  folderId?: string | null
}

interface MembraneMeta {
  id: string
  name: string
  color: string
  icon: string
}

interface PreviewData {
  lastMessage: string
  agentStatus: string
}

/** Age of `ts` at `now`, in the list's compact form: now, 5m, 3h, 2d. */
export function shortRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h`
  return `${Math.floor(diff / 86400_000)}d`
}

/**
 * Apply a `thread.updated` payload ({ threadId, patch } or { thread }) to the list.
 * `lastActivity` only moves forward: the list's value may come from the backend's
 * on-disk activity overlay, which can be newer than the registry's.
 */
export function applyThreadUpdate(list: ThreadEntry[], payload: any): ThreadEntry[] {
  const id = payload?.thread?.id ?? payload?.threadId ?? payload?.id
  if (!id) return list
  const patch = payload?.patch ?? payload?.thread ?? {}
  return list.map((t) =>
    t.id === id
      ? { ...t, ...patch, lastActivity: Math.max(t.lastActivity ?? 0, patch.lastActivity ?? 0) || t.lastActivity }
      : t
  )
}

/** Drop a deleted thread from the list. */
export function removeThread(list: ThreadEntry[], id: string): ThreadEntry[] {
  return list.filter((t) => t.id !== id)
}

/** Apply a successful pin or unpin to the list. */
export function pinInList(list: ThreadEntry[], id: string, pinnedAt: number | undefined): ThreadEntry[] {
  return list.map((t) => (t.id === id ? { ...t, pinnedAt } : t))
}

/**
 * Reorder the list at once (a drop), then save it; puts the old order back if
 * the save fails. The shared store (header picker) is updated by `reorderThreads`.
 */
export async function reorderInList(
  get: () => ThreadEntry[],
  set: (list: ThreadEntry[]) => void,
  plan: ReorderPlan,
  save: (plan: ReorderPlan) => Promise<void> = reorderThreads
): Promise<void> {
  const snapshot = snapshotOrder(get(), plan.ids)
  set(applyReorder(get(), plan))
  try {
    await save(plan)
  } catch (err) {
    set(restoreOrder(get(), snapshot))
    throw err
  }
}

/**
 * File a thread in a folder, or (`null`) take it out, at once (it lands at the
 * top of its new list), then save it; puts it back if the save fails.
 */
export async function moveInList(
  get: () => ThreadEntry[],
  set: (list: ThreadEntry[]) => void,
  id: string,
  folderId: string | null,
  save: (id: string, folderId: string | null) => Promise<void> = moveThreadToFolder
): Promise<void> {
  const before = get().find((t) => t.id === id)
  if (!before || (before.folderId ?? null) === folderId) return
  set(get().map((t) => (t.id === id ? { ...t, folderId, sortOrder: null } : t)))
  try {
    await save(id, folderId)
  } catch (err) {
    set(get().map((t) => (t.id === id ? { ...t, folderId: before.folderId, sortOrder: before.sortOrder } : t)))
    throw err
  }
}

/** Apply a successful rename to the list. */
export function renameInList(list: ThreadEntry[], id: string, label: string): ThreadEntry[] {
  return list.map((t) => (t.id === id ? { ...t, label } : t))
}

// Re-render ages this often so "now" turns into "1m" without new data.
const CLOCK_MS = 30_000

export default function ThreadList() {
  const [threads, setThreads] = createSignal<ThreadEntry[]>([])
  const [membranes, setMembranes] = createSignal<MembraneMeta[]>([])
  const [previews, setPreviews] = createSignal<Record<string, PreviewData>>({})
  const [search, setSearch] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())
  // Rename / Delete per thread (⋯ or right-click). The store's deleteThread also
  // moves the open thread elsewhere when it is the one deleted.
  const actions = createThreadActions({
    onDeleted: (id) => setThreads((prev) => removeThread(prev, id)),
    onRenamed: (id, label) => setThreads((prev) => renameInList(prev, id, label)),
    onPinned: (id, pinnedAt) => setThreads((prev) => pinInList(prev, id, pinnedAt)),
    // This list keeps its own copy: file the thread here, and save through moveInList.
    move: (id, folderId) => moveInList(threads, setThreads, id, folderId)
  })

  // Drag to reorder (⠿ grip, or drag a row with the mouse); drop on a folder to file it there.
  let listEl: HTMLDivElement | undefined
  const [reorderError, setReorderError] = createSignal('')
  const onReorder = (plan: ReorderPlan) => {
    setReorderError('')
    reorderInList(threads, setThreads, plan).catch((err: Error) => setReorderError(err.message || 'Reorder failed'))
  }
  const onMove = (id: string, folderId: string | null) => {
    setReorderError('')
    moveInList(threads, setThreads, id, folderId).catch((err: Error) => setReorderError(err.message || 'Move failed'))
  }
  const folderHub = createFolderDragHub()
  const drag = createThreadDrag({
    items: () => layout().main,
    container: () => listEl,
    list: 'main',
    onReorder,
    onMoveToFolder: onMove
  })
  const offHub = folderHub.add('main', drag)
  onCleanup(() => {
    offHub()
    drag.dispose()
  })

  const membraneMap = createMemo(() => {
    const m = new Map<string, MembraneMeta>()
    for (const mb of membranes()) m.set(mb.id, mb)
    return m
  })

  const query = () => search().toLowerCase().trim()
  // Pinned threads, then the folders (A–Z) with theirs, then the rest. A search
  // shows the folders whose name or threads match, open.
  const layout = createMemo(() => {
    const q = query()
    const filter = q
      ? {
          thread: (t: ThreadEntry) => {
            const mb = t.membraneId ? membraneMap().get(t.membraneId) : null
            return (
              (t.label ?? '').toLowerCase().includes(q) ||
              (mb?.name ?? '').toLowerCase().includes(q) ||
              (previews()[t.id]?.lastMessage ?? '').toLowerCase().includes(q)
            )
          },
          folder: (f: { name: string }) => f.name.toLowerCase().includes(q)
        }
      : undefined
    return layoutThreads(threads().filter(isListed), folders(), filter)
  })
  const isEmpty = () => layout().main.length === 0 && layout().folders.length === 0

  async function loadThreads() {
    try {
      const [threadsRes, membranesRes] = await Promise.all([fetch('/api/threads'), fetch('/api/membranes')])
      if (threadsRes.ok) {
        const data = await threadsRes.json()
        setThreads(Array.isArray(data) ? data : (data.threads ?? []))
      }
      if (membranesRes.ok) {
        const data = await membranesRes.json()
        setMembranes(data.membranes ?? [])
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }

  async function loadPreviews(threadIds: string[]) {
    const batch = threadIds.slice(0, 30)
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const res = await fetch(`/api/threads/${encodeURIComponent(id)}/preview`, { signal: AbortSignal.timeout(3000) })
        if (!res.ok) return null
        const data = await res.json()
        return { id, preview: data as PreviewData }
      })
    )
    const next: Record<string, PreviewData> = { ...previews() }
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        next[r.value.id] = r.value.preview
      }
    }
    setPreviews(next)
  }

  onMount(() => {
    loadThreads().then(() => {
      const ids = sortThreads(threads().filter(isListed))
        .slice(0, 30)
        .map((t) => t.id)
      if (ids.length) loadPreviews(ids)
    })

    // The server sends `thread.updated` when a turn finishes (lastActivity) and on
    // renames/status changes; creations and deletions change membership, so reload.
    wsStore.subscribe(['threads'])
    const offs = [
      wsStore.on('thread.updated', (msg: any) => setThreads((prev) => applyThreadUpdate(prev, msg?.payload ?? msg))),
      // A full reload remounts every row, so hold it while a menu or rename field is open.
      wsStore.on('thread.created', () => {
        if (!actions.busy()) void loadThreads()
      }),
      wsStore.on('thread.deleted', (msg: any) => {
        const p = msg?.payload ?? msg
        const id = p?.threadId ?? p?.thread?.id ?? p?.id
        if (id) setThreads((prev) => removeThread(prev, id))
        else if (!actions.busy()) void loadThreads()
      })
    ]
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS)
    // Events missed while the tab slept (phone locked, socket reconnecting): catch up on return.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setNow(Date.now())
      if (!actions.busy()) void loadThreads()
    }
    document.addEventListener('visibilitychange', onVisible)
    onCleanup(() => {
      for (const off of offs) off()
      wsStore.unsubscribe(['threads'])
      clearInterval(clock)
      document.removeEventListener('visibilitychange', onVisible)
    })
  })

  function selectThread(id: string) {
    setThreadKey(id)
    window.location.hash = `#thread=${id}`
    closeDashboardModal()
  }

  return (
    <div class="flex h-full flex-col">
      <div class="shrink-0 px-3 pt-3 pb-2">
        <input
          type="text"
          placeholder="Search threads..."
          class="w-full rounded border px-2.5 py-1.5 text-xs outline-none"
          style={{
            background: 'var(--c-bg)',
            'border-color': 'var(--c-border)',
            color: 'var(--c-text)'
          }}
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
        <NewFolderButton class="mt-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors" />
      </div>

      <Show when={reorderError()}>
        <div class="shrink-0 px-3 pb-1 text-xs" style={{ color: 'var(--c-danger, #e5484d)' }} role="alert">
          {reorderError()}
        </div>
      </Show>

      <div ref={(el) => (listEl = el)} class="flex-1 overflow-y-auto px-1">
        <Show when={!loading()} fallback={<div class="px-3 py-4 text-xs opacity-40">Loading...</div>}>
          <Show when={!isEmpty()} fallback={<div class="px-3 py-4 text-xs opacity-40">No threads</div>}>
            <For each={layout().main.slice(0, layout().pinnedCount)}>
              {(t, i) => row(t, i, () => i() === layout().main.length - 1, drag, 'main')}
            </For>
            <For each={layout().folders}>
              {(f) => (
                <FolderBlock
                  folder={f}
                  threads={() => layout().inFolder.get(f.id) ?? []}
                  container={() => listEl}
                  hub={folderHub}
                  onReorder={onReorder}
                  onMove={onMove}
                  forceOpen={() => !!query()}
                  rowClass="rounded-md"
                  row={(t, i, isLast, d, list) => row(t, i, isLast, d, list)}
                />
              )}
            </For>
            <For each={layout().main.slice(layout().pinnedCount)}>
              {(t, i) => {
                const index = () => layout().pinnedCount + i()
                return row(t, index, () => index() === layout().main.length - 1, drag, 'main')
              }}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )

  /** One thread row: of the main list (`list` "main") or of a folder (`list` its id). */
  function row(thread: ThreadEntry, i: () => number, isLast: () => boolean, drag: ThreadDrag, list: string) {
    const mb = () => (thread.membraneId ? membraneMap().get(thread.membraneId) : null)
    const preview = () => previews()[thread.id]
    const isActive = () => thread.agentStatus === 'working' || thread.agentStatus === 'thinking'
    const isCurrent = () => threadKey() === thread.id

    return (
      <>
        <div
          role="button"
          tabIndex={0}
          data-thread-row={thread.id}
          data-drag-list={list}
          class="group relative flex w-full cursor-pointer items-start gap-1.5 rounded-md py-2 pr-1 pl-0.5 text-left transition-colors"
          style={{
            background: isCurrent() ? 'var(--c-hover-bg-strong)' : 'transparent',
            color: 'var(--c-text)',
            opacity: drag.draggingId() === thread.id ? 0.45 : undefined
          }}
          onPointerDown={(e) => drag.onRowPointerDown(e, thread.id)}
          onMouseEnter={(e) => {
            if (!isCurrent()) e.currentTarget.style.background = 'var(--c-hover-bg)'
          }}
          onMouseLeave={(e) => {
            if (!isCurrent()) e.currentTarget.style.background = 'transparent'
          }}
          onClick={() => {
            if (!actions.isRenaming(thread.id)) selectThread(thread.id)
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              selectThread(thread.id)
            }
          }}
          onContextMenu={(e) => actions.onContextMenu(thread.id, e)}
        >
          <DropLine show={drag.lineAt(i())} pinned={drag.target()?.pinned} />
          <Show when={isLast()}>
            <DropLine show={drag.lineAt(i() + 1)} pinned={drag.target()?.pinned} at="bottom" />
          </Show>
          <DragGrip drag={drag} threadId={thread.id} class="-my-2 w-4" />
          {/* Activity indicator */}
          <span
            class="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
            style={{
              background: isActive() ? '#4aff8a' : 'var(--c-text-muted)',
              opacity: isActive() ? 1 : 0.3
            }}
          />

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              {/* Membrane badge */}
              <Show when={mb()}>
                {(m) => (
                  <span
                    class="inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[9px] leading-none font-medium"
                    style={{ background: `${m().color}20`, color: m().color }}
                  >
                    {m().name}
                  </span>
                )}
              </Show>

              <Show
                when={actions.isRenaming(thread.id)}
                fallback={
                  <>
                    <span class="truncate text-xs font-medium">{thread.label || thread.id.slice(0, 8)}</span>
                    <PinMark thread={thread} />
                  </>
                }
              >
                <ThreadRenameInput
                  initial={thread.label ?? ''}
                  onSave={(label) => actions.saveRename(thread.id, label)}
                  onDone={actions.stopRename}
                />
              </Show>

              <span class="ml-auto shrink-0 text-[10px] opacity-40">
                {shortRelativeTime(thread.lastActivity, now())}
              </span>
            </div>

            <Show when={preview()?.lastMessage}>
              <p class="mt-0.5 truncate text-[11px] opacity-50">{preview()!.lastMessage}</p>
            </Show>
          </div>

          <ThreadActionsButton actions={actions} threadId={thread.id} />
        </div>
        <ThreadActionsMenu actions={actions} thread={thread} class="mx-2.5 mb-1 overflow-hidden rounded-md text-xs" />
      </>
    )
  }
}
