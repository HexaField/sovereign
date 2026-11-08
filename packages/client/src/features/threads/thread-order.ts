// Thread list order, shared by every thread list: pinned threads first (most
// recently pinned first), then the rest by last activity, newest first.

/** The fields the order reads. `pinnedAt` may arrive as `null` from a `thread.updated` unpin. */
export interface Orderable {
  pinnedAt?: number | null
  lastActivity?: number
}

/** True when the thread is pinned to the top. */
export function isPinned(t: Orderable): boolean {
  return typeof t.pinnedAt === 'number' && t.pinnedAt > 0
}

/**
 * Compare two threads by pin only: pinned before unpinned, the more recently
 * pinned first. 0 when neither is pinned, so a list can fall back to its own order.
 */
export function comparePins(a: Orderable, b: Orderable): number {
  const pa = isPinned(a) ? (a.pinnedAt as number) : 0
  const pb = isPinned(b) ? (b.pinnedAt as number) : 0
  return pb - pa
}

/** Pins first, then by last activity, newest first. */
export function compareThreads(a: Orderable, b: Orderable): number {
  return comparePins(a, b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0)
}

/** A sorted copy of `list` in thread-list order. */
export function sortThreads<T extends Orderable>(list: readonly T[]): T[] {
  return [...list].sort(compareThreads)
}
