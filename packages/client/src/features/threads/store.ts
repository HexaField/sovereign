import { createSignal } from 'solid-js'
import type { ThreadInfo } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'

// Single source of truth for the thread shape: the canonical `ThreadInfo`
// from @sovereign/core (bare UUID `id`, no `key`). Importing it here means a
// stale `thread.key` access is a compile error rather than a silent runtime
// "empty dropdown".
export type { ThreadInfo }

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
        const first = raw[0]
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
      // Switch to most recent thread (server returns sorted by lastActivity desc)
      const first = raw[0]
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

function dropThread(key: string): void {
  const remaining = threads().filter((t) => t.id !== key)
  setThreads(remaining)
  if (threadKey() !== key) return
  const next = [...remaining].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0]
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
        // An unpin arrives as `pinnedAt: null`; store it as unset.
        if (patch.pinnedAt === null) patch.pinnedAt = undefined
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

  // Fetch initial threads for active org
  fetchThreadsForOrg()

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
