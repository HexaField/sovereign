import { createSignal } from 'solid-js'
import type { ThreadInfo, ThreadFolder } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'
import { resetPresenceThreadCache } from './presence-helper.js'
import { isListed } from './thread-order.js'
import { applyReorder, restoreOrder, snapshotOrder, type ReorderPlan } from './thread-drag.js'
import { loadOpenFolders, saveOpenFolders } from './thread-folders.js'

// Single source of truth for the thread shape: the canonical `ThreadInfo`
// from @sovereign/core (bare UUID `id`, no `key`). Importing it here means a
// stale `thread.key` access is a compile error rather than a silent runtime
// "empty dropdown".
export type { ThreadInfo, ThreadFolder }

/** Convenience accessor — first workspace, or undefined. */
export function threadPrimaryWorkspace(t: ThreadInfo): string | undefined {
  return t.workspaceIds?.[0]
}

// The thread identifier signal holds the bare UUID `id` (empty until the
// initial fetch / hash resolves to a real thread).
export const [threadKey, setThreadKey] = createSignal('')
export const [threads, setThreads] = createSignal<ThreadInfo[]>([])
export const [activeOrgIdForThreads, setActiveOrgIdForThreads] = createSignal('_global')

let ws: WsStore | null = null
let popstateHandler: ((e: PopStateEvent) => void) | null = null
let hashchangeHandler: ((e: HashChangeEvent) => void) | null = null

function readThreadFromHash(): string {
  if (typeof location === 'undefined') return ''
  const hash = location.hash
  const match = hash.match(/#thread=(.+)/)
  return match ? match[1] : ''
}

export function fetchThreadsForOrg(orgId?: string): void {
  const id = orgId ?? activeOrgIdForThreads()
  // Clear stale threads immediately so the UI doesn't show the previous workspace's threads
  setThreads([])
  const url = id ? `/api/threads?orgId=${encodeURIComponent(id)}` : '/api/threads'
  fetch(url)
    .then((r) => r.json())
    .then((data: any) => {
      const raw: ThreadInfo[] = (data.threads ?? data ?? []).filter((t: ThreadInfo) => t.id)
      setThreads(raw)
      // Reconcile: if current threadKey doesn't exist in this workspace's threads,
      // keep it anyway if it looks like a valid thread key (user navigated directly).
      // Only auto-switch if the current key is empty.
      const current = threadKey()
      if (!current) {
        // The most recent thread the lists show (never the hidden internal presence thread).
        const first = raw.find(isListed)
        if (first) {
          setThreadKey(first.id)
          if (typeof history !== 'undefined') {
            const u = new URL(location.href)
            u.hash = `thread=${first.id}`
            history.replaceState(null, '', u.toString())
          }
        }
      }
    })
    .catch(() => {})
}

export function switchWorkspaceThreads(orgId: string): void {
  setActiveOrgIdForThreads(orgId)
  // Fetch threads and auto-switch to most recent
  const url = `/api/threads?orgId=${encodeURIComponent(orgId)}`
  fetch(url)
    .then((r) => r.json())
    .then((data: any) => {
      const raw: ThreadInfo[] = (data.threads ?? data ?? []).filter((t: ThreadInfo) => t.id)
      setThreads(raw)
      // Switch to the most recent listed thread (server returns sorted by lastActivity desc)
      const first = raw.find(isListed)
      if (first) {
        setThreadKey(first.id)
        if (typeof history !== 'undefined') {
          const u = new URL(location.href)
          u.hash = `thread=${first.id}`
          history.replaceState(null, '', u.toString())
        }
      } else {
        // No threads in this workspace — clear selection
        setThreadKey('')
        if (typeof history !== 'undefined') {
          const u = new URL(location.href)
          u.hash = ''
          history.replaceState(null, '', u.toString())
        }
      }
    })
    .catch(() => {
      setThreads([])
      setThreadKey('')
    })
}

export function switchThread(key: string): void {
  setThreadKey(key)
  if (typeof history !== 'undefined') {
    const u = new URL(location.href)
    u.hash = `thread=${key}`
    history.replaceState(null, '', u.toString())
  }
}

export function createThread(label?: string, opts?: { backend?: string }): Promise<void> {
  const orgId = activeOrgIdForThreads()
  const workspaceIds = orgId && orgId !== '_global' ? [orgId] : undefined
  return fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, workspaceIds, ...(opts?.backend ? { backend: opts.backend } : {}) })
  })
    .then((r) => r.json())
    .then((data: any) => {
      const thread = (data.thread ?? data) as ThreadInfo
      setThreads((prev) => [...prev, thread])
      // Switch to the newly created thread
      if (thread.id) {
        switchThread(thread.id)
      }
    })
}

export function moveThread(key: string, orgId: string): Promise<void> {
  // Move a thread between workspaces. `_global` collapses to an empty
  // workspace list (no code context); any other orgId becomes the sole
  // entry. Membrane assignment is preserved — moving across workspaces
  // doesn't change the social context.
  const workspaceIds = orgId === '_global' ? [] : [orgId]
  return fetch(`/api/threads/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceIds })
  })
    .then((r) => r.json())
    .then((data: any) => {
      const updated = data.thread as ThreadInfo
      setThreads((prev) => prev.map((t) => (t.id === key ? updated : t)))
    })
}

/** Rename a thread. The server trims the label and rejects an empty one. */
export async function renameThread(key: string, label: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(key)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Rename failed (${res.status})`)
  const updated = data.thread as ThreadInfo
  setThreads((prev) => prev.map((t) => (t.id === key ? { ...t, label: updated.label } : t)))
}

/**
 * Pin a thread to the top of the thread lists, or unpin it. Applies at once
 * and reverts if the server refuses. The server's `pinnedAt` replaces the
 * optimistic one, so every list orders the pins alike. Resolves to the new `pinnedAt`.
 */
export async function pinThread(key: string, pinned: boolean): Promise<number | undefined> {
  const previous = threads().find((t) => t.id === key)?.pinnedAt
  const setPinnedAt = (pinnedAt: number | undefined) =>
    setThreads((prev) => prev.map((t) => (t.id === key ? { ...t, pinnedAt } : t)))
  setPinnedAt(pinned ? (previous ?? Date.now()) : undefined)
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned })
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `${pinned ? 'Pin' : 'Unpin'} failed (${res.status})`)
    const updated = data.thread as ThreadInfo | undefined
    const pinnedAt = updated ? (updated.pinnedAt ?? undefined) : pinned ? (previous ?? Date.now()) : undefined
    setPinnedAt(pinnedAt)
    return pinnedAt
  } catch (err) {
    setPinnedAt(previous)
    throw err
  }
}

/**
 * Put threads in a manual order (a drag in a thread list). `plan.ids` is one
 * group (pinned or not) in its new order; `plan.pinned` pins or unpins them
 * (a drag across the pinned line). Applies at once, takes the server's values
 * when it answers, and reverts (then throws) if the server refuses.
 * Other tabs and devices follow through the `thread.updated` broadcasts.
 */
export async function reorderThreads(plan: ReorderPlan): Promise<void> {
  const snapshot = snapshotOrder(threads(), plan.ids)
  setThreads((prev) => applyReorder(prev, plan))
  try {
    const res = await fetch('/api/threads/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan)
    })
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `Reorder failed (${res.status})`)
    const stored = new Map<string, ThreadInfo>(
      (Array.isArray(data.threads) ? (data.threads as ThreadInfo[]) : []).filter((t) => t?.id).map((t) => [t.id, t])
    )
    setThreads((prev) =>
      prev.map((t) => {
        const s = stored.get(t.id)
        return s ? { ...t, pinnedAt: s.pinnedAt ?? undefined, sortOrder: s.sortOrder ?? undefined } : t
      })
    )
  } catch (err) {
    setThreads((prev) => restoreOrder(prev, snapshot))
    throw err
  }
}

// ── Folders (user-made; one level). Layout rule: thread-folders.ts ──────────

export const [folders, setFolders] = createSignal<ThreadFolder[]>([])
/** The folders open in the thread lists (shared by every list, kept per browser). */
export const [openFolders, setOpenFolders] = createSignal<ReadonlySet<string>>(loadOpenFolders())

export function isFolderOpen(id: string): boolean {
  return openFolders().has(id)
}

export function setFolderOpen(id: string, open: boolean): void {
  const next = new Set(openFolders())
  if (open) next.add(id)
  else next.delete(id)
  setOpenFolders(next)
  saveOpenFolders(next)
}

export function toggleFolder(id: string): void {
  setFolderOpen(id, !isFolderOpen(id))
}

async function folderRequest(url: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

export async function fetchFolders(): Promise<void> {
  try {
    const data = await folderRequest('/api/thread-folders', 'GET')
    if (Array.isArray(data.folders)) setFolders(data.folders)
  } catch {
    /* a server without folders: the lists show none */
  }
}

/** Make a folder (open, so its first threads show). Throws the server's reason (empty or taken name). */
export async function createFolder(name: string): Promise<ThreadFolder> {
  const { folder } = await folderRequest('/api/thread-folders', 'POST', { name })
  setFolders((prev) => (prev.some((f) => f.id === folder.id) ? prev : [...prev, folder]))
  setFolderOpen(folder.id, true)
  return folder
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const { folder } = await folderRequest(`/api/thread-folders/${encodeURIComponent(id)}`, 'PATCH', { name })
  setFolders((prev) => prev.map((f) => (f.id === id ? folder : f)))
}

/** Delete a folder; its threads go back to the main list (never deleted). Applies at once, reverts on error. */
export async function deleteFolder(id: string): Promise<void> {
  const before = {
    folders: folders(),
    members: threads()
      .filter((t) => t.folderId === id)
      .map((t) => t.id)
  }
  setFolders((prev) => prev.filter((f) => f.id !== id))
  setThreads((prev) => prev.map((t) => (t.folderId === id ? unfiled(t) : t)))
  try {
    await folderRequest(`/api/thread-folders/${encodeURIComponent(id)}`, 'DELETE')
    setFolderOpen(id, false)
  } catch (err) {
    setFolders(before.folders)
    const members = new Set(before.members)
    setThreads((prev) => prev.map((t) => (members.has(t.id) ? { ...t, folderId: id } : t)))
    throw err
  }
}

function unfiled(t: ThreadInfo): ThreadInfo {
  const { folderId: _f, sortOrder: _s, ...rest } = t
  return rest as ThreadInfo
}

/**
 * File a thread in a folder, or take it out (`null`): it lands at the top of
 * its new list. Applies at once and reverts (then throws) if the server refuses.
 */
export async function moveThreadToFolder(id: string, folderId: string | null): Promise<void> {
  // A thread of another workspace is not in this list; the server still moves it.
  const previous = threads().find((t) => t.id === id)
  if (previous && (previous.folderId ?? null) === folderId) return
  const filed = (t: ThreadInfo): ThreadInfo => (folderId ? { ...unfiled(t), folderId } : unfiled(t))
  setThreads((prev) => prev.map((t) => (t.id === id ? filed(t) : t)))
  try {
    await folderRequest(`/api/threads/${encodeURIComponent(id)}/folder`, 'PUT', { folderId })
  } catch (err) {
    if (previous)
      setThreads((prev) =>
        prev.map((t) => (t.id === id ? { ...t, folderId: previous.folderId, sortOrder: previous.sortOrder } : t))
      )
    throw err
  }
}

/** Archive a thread — a soft delete: the server flags it archived and its
 *  history is kept. If it was open, the most recently active remaining thread opens instead. */
export async function deleteThread(key: string): Promise<void> {
  const res = await fetch(`/api/threads/${encodeURIComponent(key)}`, { method: 'DELETE' })
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Archive failed (${res.status})`)
  }
  dropThread(key)
}

/** Until this time, a new main (gateway) presence thread opens when it arrives:
 *  set when the user archives the main thread they have open. */
let followGatewayUntil = 0
const FOLLOW_GATEWAY_MS = 10_000

function dropThread(key: string): void {
  const dropped = threads().find((t) => t.id === key)
  // Archiving a presence thread hands its role to a fresh thread.
  if (dropped?.presence) resetPresenceThreadCache()
  if (dropped?.presence === 'gateway' && threadKey() === key) followGatewayUntil = Date.now() + FOLLOW_GATEWAY_MS
  const remaining = threads().filter((t) => t.id !== key)
  setThreads(remaining)
  if (threadKey() !== key) return
  // Open the most recently active thread the lists show (not the internal presence thread).
  const next = remaining.filter(isListed).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0]
  if (next) {
    switchThread(next.id)
    return
  }
  setThreadKey('')
  if (typeof history !== 'undefined') {
    const u = new URL(location.href)
    u.hash = ''
    history.replaceState(null, '', u.toString())
  }
}

export function addEntity(threadKeyVal: string, entity: ThreadInfo['entities'][0]): Promise<void> {
  return fetch(`/api/threads/${threadKeyVal}/entities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entity)
  }).then(() => {})
}

export function removeEntity(threadKeyVal: string, entityType: string, entityRef: string): Promise<void> {
  return fetch(`/api/threads/${threadKeyVal}/entities/${entityType}/${entityRef}`, {
    method: 'DELETE'
  }).then(() => {})
}

export function initThreadStore(wsStore?: WsStore, initialOrgId?: string): () => void {
  ws = wsStore ?? null

  // Sync org filter with the workspace that was restored from localStorage
  if (initialOrgId) {
    setActiveOrgIdForThreads(initialOrgId)
  }

  // Read initial thread from hash
  setThreadKey(readThreadFromHash())

  // Listen for popstate (back/forward) AND hashchange (programmatic hash
  // assignments — e.g. the service worker forwarding a notification click to
  // `window.location.hash = 'thread=…'`). Both funnel through readThreadFromHash
  // so downstream signals stay consistent.
  popstateHandler = () => setThreadKey(readThreadFromHash())
  hashchangeHandler = () => setThreadKey(readThreadFromHash())
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', popstateHandler)
    globalThis.addEventListener('hashchange', hashchangeHandler)
  }

  const unsubs: Array<() => void> = []

  if (ws) {
    // Subscribe to threads WS channel for real-time updates
    ws.subscribe(['threads'])

    unsubs.push(
      ws.on('thread.created', (msg: any) => {
        const thread = (msg?.payload?.thread ?? msg) as ThreadInfo
        if (!thread.id) return // skip malformed threads
        setThreads((prev) => {
          if (prev.some((t) => t.id === thread.id)) return prev
          return [...prev, thread]
        })
        if (thread.presence) resetPresenceThreadCache()
        // The replacement for the main thread the user just archived: open it.
        if (thread.presence === 'gateway' && Date.now() < followGatewayUntil) {
          followGatewayUntil = 0
          switchThread(thread.id)
        }
      })
    )

    unsubs.push(
      ws.on('thread.updated', (msg: any) => {
        // Server emits { threadId, patch } for in-place updates (and a full
        // { thread } for some events) — handle both, keyed by `id`.
        const p = msg?.payload ?? msg
        const id = p?.thread?.id ?? p?.threadId ?? p?.id
        if (!id) return
        const patch = { ...(p?.patch ?? p?.thread ?? p) }
        // An unpin arrives as `pinnedAt: null`, a dropped manual place as
        // `sortOrder: null`; store them as unset.
        if (patch.pinnedAt === null) patch.pinnedAt = undefined
        if (patch.sortOrder === null) patch.sortOrder = undefined
        if (patch.folderId === null) patch.folderId = undefined
        // A presence role moved: the cached presence ids may be stale.
        if ('presence' in patch) resetPresenceThreadCache()
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
      })
    )

    unsubs.push(
      ws.on('thread.deleted', (msg: any) => {
        const p = msg?.payload ?? msg
        const id = p?.threadId ?? p?.thread?.id ?? p?.id
        if (id) dropThread(id)
      })
    )

    unsubs.push(
      ws.on('thread.folders', (msg: any) => {
        const list = (msg?.payload ?? msg)?.folders
        if (Array.isArray(list)) setFolders(list.filter((f: ThreadFolder) => f?.id && typeof f.name === 'string'))
      })
    )

    unsubs.push(
      ws.on('thread.status', (msg: any) => {
        const data = msg?.payload ?? msg
        const id = data.threadId ?? data.id
        if (!id) return
        setThreads((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  lastActivity: data.lastActivity ?? t.lastActivity,
                  unreadCount: data.unreadCount ?? t.unreadCount,
                  agentStatus: data.agentStatus ?? t.agentStatus
                }
              : t
          )
        )
      })
    )
  }

  // Fetch initial threads for active org, and the folders
  fetchThreadsForOrg()
  void fetchFolders()

  return () => {
    unsubs.forEach((u) => u())
    if (typeof globalThis.removeEventListener === 'function') {
      if (popstateHandler) globalThis.removeEventListener('popstate', popstateHandler)
      if (hashchangeHandler) globalThis.removeEventListener('hashchange', hashchangeHandler)
    }
  }
}

/** @internal — for testing */
export function _triggerPopstate(): void {
  if (popstateHandler) popstateHandler({ type: 'popstate' } as any)
}
