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

export function createThread(label?: string): Promise<void> {
  const orgId = activeOrgIdForThreads()
  const workspaceIds = orgId && orgId !== '_global' ? [orgId] : undefined
  return fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, workspaceIds })
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

  // Listen for popstate
  popstateHandler = () => setThreadKey(readThreadFromHash())
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', popstateHandler)
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
        const patch = p?.patch ?? p?.thread ?? p
        setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
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
    if (popstateHandler && typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('popstate', popstateHandler)
    }
  }
}

/** @internal — for testing */
export function _triggerPopstate(): void {
  if (popstateHandler) popstateHandler({ type: 'popstate' } as any)
}
