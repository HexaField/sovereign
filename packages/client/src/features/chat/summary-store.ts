// Client store for the rolling conversation summary — powers the header
// summary bubble. The server generates a summary only for the presence
// gateway thread (see @sovereign/voice conversation-summary.ts), so this
// store naturally holds an empty string whenever the current thread
// differs from the gateway thread; SummaryBubble handles the visibility
// gating itself.
//
// Lifecycle:
//   - threadKey changes → clear the stale value, fetch the current summary
//     via REST (handles initial load / page refresh / thread switch)
//   - WS `chat.summary` → live update once a new summary generates,
//     applied only when it matches the thread currently open
//
// Thread-change detection polls the accessor on a short interval rather
// than tracking it via a Solid effect — the same style already used for
// peripheral watchers in this client (HealthPopover's context-health poll,
// presence's reconnect check). A summary bubble tolerates a brief lag
// between switching threads and its content catching up, and polling keeps
// this store a plain function, directly testable without a component tree.
//
// Called once from App.tsx onMount, mirroring initPresence(threadKey, ws).

import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

const POLL_MS = 200

const [summary, setSummary] = createSignal('')

export { summary }

/** Whether a summary currently exists for the open thread. */
export function hasSummary(): boolean {
  return summary().trim().length > 0
}

/** Fetch the current summary for a thread from the REST endpoint. Guards
 *  against a stale response landing after the user switches threads again. */
function fetchSummary(threadKey: Accessor<string>, key: string): void {
  fetch(`/api/threads/${encodeURIComponent(key)}/summary`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { summary?: string } | null) => {
      if (data?.summary && threadKey() === key) setSummary(data.summary)
    })
    .catch(() => {
      // First-render best-effort — a later WS push backfills once a
      // summary generates.
    })
}

export function initSummaryStore(ws: WsStore, threadKey: Accessor<string>): () => void {
  ws.subscribe(['chat'])

  const offSummary = ws.on('chat.summary', (msg: Record<string, unknown>) => {
    const threadId = msg?.threadId
    const text = msg?.summary
    if (typeof threadId !== 'string' || typeof text !== 'string') return
    if (threadId !== threadKey()) return
    setSummary(text)
  })

  let lastKey: string | null = null
  const applyThreadChange = (key: string): void => {
    if (key === lastKey) return
    lastKey = key
    setSummary('')
    if (!key) return
    fetchSummary(threadKey, key)
  }

  // Prime immediately for the thread active when the store starts.
  applyThreadChange(threadKey())

  const pollTimer = setInterval(() => applyThreadChange(threadKey()), POLL_MS)

  return () => {
    clearInterval(pollTimer)
    offSummary()
    setSummary('')
  }
}
