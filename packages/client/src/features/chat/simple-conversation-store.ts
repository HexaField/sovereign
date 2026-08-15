// Client store for the simple conversation — the user↔Hex dialogue
// stripped of internal reasoning, tool calls, and subagent work.
//
// Data flows:
//   - REST: GET /api/presence/simple-conversation (initial load)
//   - WS:   `chat.simple-conversation` events (live push)
//
// The toggle signal `showSimpleView` controls whether the Hex tab shows
// the full conversation or the simple view. The SummaryBubble icon
// drives this toggle.

import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

export interface SimpleConversationEntry {
  role: 'user' | 'hex'
  text: string
  modality: string
  timestamp: string
}

const [entries, setEntries] = createSignal<SimpleConversationEntry[]>([])
const [showSimpleView, setShowSimpleView] = createSignal(false)

export { entries as simpleConversationEntries, showSimpleView }

export function toggleSimpleView(): void {
  setShowSimpleView((prev) => !prev)
}

export function initSimpleConversationStore(ws: WsStore, threadKey: Accessor<string>): () => void {
  ws.subscribe(['chat'])

  // Live push — new entries arrive one at a time.
  const offEntry = ws.on('chat.simple-conversation', (msg: Record<string, unknown>) => {
    const entry = msg?.entry as SimpleConversationEntry | undefined
    if (!entry?.text) return
    setEntries((prev) => [...prev, entry])
  })

  // Fetch on init
  void fetchEntries()

  // Re-fetch when the thread changes (in case the gateway thread shifted)
  let lastKey = threadKey()
  const pollTimer = setInterval(() => {
    const key = threadKey()
    if (key !== lastKey) {
      lastKey = key
      void fetchEntries()
    }
  }, 500)

  return () => {
    clearInterval(pollTimer)
    offEntry()
    setEntries([])
    setShowSimpleView(false)
  }
}

async function fetchEntries(): Promise<void> {
  try {
    const res = await fetch('/api/presence/simple-conversation')
    if (!res.ok) return
    const data = (await res.json()) as { entries?: SimpleConversationEntry[] }
    if (data?.entries) setEntries(data.entries)
  } catch {
    // Best-effort — WS push backfills live.
  }
}
