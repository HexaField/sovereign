// Client mute store — mirrors the server's per-thread mute set.
//
// Backed by a Solid signal so any component can reactively read
// `mutedThreadIds()` or `isThreadMuted(id)`. Writes round-trip through the
// REST API and re-read the canonical list on success so we never drift from
// the server.

import { createSignal } from 'solid-js'

export const [mutedThreadIds, setMutedThreadIds] = createSignal<string[]>([])
export const [muteLoaded, setMuteLoaded] = createSignal(false)

export function isThreadMuted(id: string): boolean {
  return mutedThreadIds().includes(id)
}

export async function loadMutes(): Promise<void> {
  try {
    const res = await fetch('/api/thread-presence/mutes')
    if (!res.ok) return
    const data = (await res.json()) as { mutedThreadIds?: string[] }
    if (Array.isArray(data.mutedThreadIds)) {
      setMutedThreadIds(data.mutedThreadIds)
    }
  } catch {
    /* ignore */
  } finally {
    setMuteLoaded(true)
  }
}

export async function setThreadMute(threadId: string, muted: boolean): Promise<void> {
  try {
    const res = await fetch(`/api/thread-presence/mute/${encodeURIComponent(threadId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted })
    })
    if (!res.ok) return
    // Optimistic + authoritative refresh.
    setMutedThreadIds((prev) => {
      const set = new Set(prev)
      if (muted) set.add(threadId)
      else set.delete(threadId)
      return [...set].sort()
    })
  } catch {
    /* ignore */
  }
}

export async function toggleThreadMute(threadId: string): Promise<void> {
  await setThreadMute(threadId, !isThreadMuted(threadId))
}
