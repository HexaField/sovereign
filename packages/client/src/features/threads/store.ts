import { createSignal } from 'solid-js'
import type { AgentStatus } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'

export interface ThreadInfo {
  key: string
  entities: { orgId: string; projectId: string; entityType: 'branch' | 'issue' | 'pr'; entityRef: string }[]
  label?: string
  lastActivity: number
  unreadCount: number
  agentStatus: AgentStatus
}

export const [threadKey, setThreadKey] = createSignal('main')
export const [threads, setThreads] = createSignal<ThreadInfo[]>([])

let ws: WsStore | null = null
let popstateHandler: ((e: PopStateEvent) => void) | null = null

function readThreadFromHash(): string {
  if (typeof location === 'undefined') return 'main'
  const hash = location.hash
  const match = hash.match(/#thread=(.+)/)
  return match ? match[1] : 'main'
}

export function switchThread(key: string): void {
  setThreadKey(key)
  if (typeof history !== 'undefined') {
    history.pushState(null, '', `#thread=${key}`)
  }
}

export function createThread(label?: string): Promise<void> {
  return fetch('/api/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label })
  })
    .then((r) => r.json())
    .then((data: any) => {
      setThreads((prev) => [...prev, data as ThreadInfo])
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

export function initThreadStore(wsStore?: WsStore): () => void {
  ws = wsStore ?? null

  // Read initial thread from hash
  setThreadKey(readThreadFromHash())

  // Listen for popstate
  popstateHandler = () => setThreadKey(readThreadFromHash())
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', popstateHandler)
  }

  const unsubs: Array<() => void> = []

  if (ws) {
    unsubs.push(
      ws.on('thread.created', (msg: any) => {
        setThreads((prev) => [...prev, msg as ThreadInfo])
      })
    )

    unsubs.push(
      ws.on('thread.updated', (msg: any) => {
        setThreads((prev) => prev.map((t) => (t.key === msg.key ? { ...t, ...msg } : t)))
      })
    )

    unsubs.push(
      ws.on('thread.status', (msg: any) => {
        setThreads((prev) =>
          prev.map((t) =>
            t.key === msg.key
              ? {
                  ...t,
                  lastActivity: msg.lastActivity ?? t.lastActivity,
                  unreadCount: msg.unreadCount ?? t.unreadCount,
                  agentStatus: msg.agentStatus ?? t.agentStatus
                }
              : t
          )
        )
      })
    )
  }

  // Fetch initial threads
  fetch('/api/threads')
    .then((r) => r.json())
    .then((data: any) => setThreads(data as ThreadInfo[]))
    .catch(() => {})

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
