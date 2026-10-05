// Client store for the simple conversation — the user↔Hex dialogue of the
// open thread, stripped of internal reasoning, tool calls, and subagent work.
//
// Data flows:
//   - REST: GET /api/threads/:id/simple-conversation while the simple view
//     shows (on toggle-on and on each thread switch). The server backfills a
//     thread's first view, and from then on summarises its replies with the
//     LLM — so the store fetches only when the view is actually in use.
//   - WS:   `chat.simple-conversation` events (live push, tagged by thread)
//
// The toggle signal `showSimpleView` controls whether the chat shows the
// full conversation or the simple view. The SummaryBubble icon drives this
// toggle. State persists to the `?simple` URL search param so a page
// refresh keeps the chosen mode.

import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

export interface SimpleConversationEntry {
  role: 'user' | 'hex'
  text: string
  modality: string
  timestamp: string
}

// ── URL search param persistence ────────────────────────────────────

function readSimpleParam(): boolean {
  if (typeof location === 'undefined') return false
  const params = new URLSearchParams(location.search)
  return params.get('simple') === '1'
}

function writeSimpleParam(active: boolean): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const url = new URL(location.href)
  if (active) url.searchParams.set('simple', '1')
  else url.searchParams.delete('simple')
  history.replaceState(null, '', url.toString())
}

// ── Signals ─────────────────────────────────────────────────────────

const [entries, setEntries] = createSignal<SimpleConversationEntry[]>([])
const [showSimpleView, setShowSimpleView] = createSignal(readSimpleParam())

export { entries as simpleConversationEntries, showSimpleView }

export function toggleSimpleView(): void {
  setShowSimpleView((prev) => {
    const next = !prev
    writeSimpleParam(next)
    return next
  })
  if (showSimpleView() && currentThread) void fetchEntries(currentThread, currentThread())
}

/** The open thread, bound by initSimpleConversationStore. */
let currentThread: Accessor<string> | null = null

// ── Init / cleanup ──────────────────────────────────────────────────

export function initSimpleConversationStore(ws: WsStore, threadKey: Accessor<string>): () => void {
  currentThread = threadKey
  // Restore from URL on init (covers page refresh)
  setShowSimpleView(readSimpleParam())

  // Live push — new entries arrive one at a time, for any thread.
  const offEntry = ws.on('chat.simple-conversation', (msg: Record<string, unknown>) => {
    const entry = msg?.entry as SimpleConversationEntry | undefined
    if (!entry?.text || msg?.threadId !== threadKey()) return
    setEntries((prev) => [...prev, entry])
  })

  // Fetch while the view shows: now, and whenever the open thread changes.
  let lastKey = threadKey()
  if (showSimpleView()) void fetchEntries(threadKey, lastKey)
  const pollTimer = setInterval(() => {
    const key = threadKey()
    if (key !== lastKey) {
      lastKey = key
      setEntries([])
      if (showSimpleView()) void fetchEntries(threadKey, key)
    }
  }, 500)

  return () => {
    clearInterval(pollTimer)
    offEntry()
    currentThread = null
    setEntries([])
    setShowSimpleView(false)
  }
}

async function fetchEntries(threadKey: Accessor<string>, key: string): Promise<void> {
  if (!key) return
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(key)}/simple-conversation`)
    if (!res.ok) return
    const data = (await res.json()) as { entries?: SimpleConversationEntry[] }
    // Ignore a response for a thread the user has already left.
    if (data?.entries && threadKey() === key) setEntries(data.entries)
  } catch {
    // Best-effort — WS push backfills live.
  }
}
