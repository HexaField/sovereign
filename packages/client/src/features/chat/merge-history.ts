// Merge a freshly-fetched history with the current in-memory turns.
//
// Why: a sent user message lives in `turns` as a synthesized SSE `turn` event
// the chat module emits the moment the agent's reply lands. The backend may
// not have flushed the user input to JSONL yet, so a concurrent
// `fetchHistory()` (triggered by SSE seq gap, ETag invalidation, or thread
// re-connect) can return a server history that DOESN'T include the user
// message. Blindly replacing `turns` with that stale history is what made
// just-sent messages "disappear until refresh".
//
// Merge rule: trust the fetched history as the canonical prefix (it's the
// authoritative persisted view), then append any local turns whose timestamp
// is strictly newer than the latest fetched turn. Older local turns are
// dropped — they're assumed to be reflected in the fetched payload (or to
// have been edited server-side).
//
// Pure / side-effect-free so we can unit test the race in isolation.

import type { ParsedTurn } from '@sovereign/core'

export function mergeFetchedHistory(local: ParsedTurn[], fetched: ParsedTurn[]): ParsedTurn[] {
  if (!fetched.length) {
    // Nothing fetched (empty thread or 304-like miss) — keep local as-is.
    return local
  }
  if (!local.length) return fetched

  let latestFetchedTs = 0
  for (const t of fetched) {
    const ts = typeof t.timestamp === 'number' ? t.timestamp : 0
    if (ts > latestFetchedTs) latestFetchedTs = ts
  }

  // Anything strictly newer than the latest persisted turn is a live tail the
  // backend hasn't seen yet — keep it.
  const tail = local.filter((t) => (typeof t.timestamp === 'number' ? t.timestamp : 0) > latestFetchedTs)
  if (tail.length === 0) return fetched

  // De-dup: don't append a local turn whose (role, content) is already the
  // last fetched turn (matches the SSE `turn` handler's replace-or-append).
  const lastFetched = fetched[fetched.length - 1]
  const filteredTail = tail.filter(
    (t) => !(lastFetched && t.role === lastFetched.role && t.content === lastFetched.content)
  )
  return [...fetched, ...filteredTail]
}
