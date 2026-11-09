// Thread list order, shared by every thread list (header picker, Overview,
// Cmd+K, System → Agents). The exact rule:
//
//   1. Pinned threads form the top group, the rest the group below.
//   2. Within each group, threads never placed by hand (no `sortOrder`: new
//      chats, and a thread just pinned or unpinned from the ⋯ menu) come first:
//      pinned ones most recently pinned first, unpinned ones by last activity,
//      newest first.
//   3. Then the threads the user placed by dragging, by `sortOrder`, lowest
//      first. Their activity does not move them; ties fall back to activity.
//
// Without any dragging this is the old order: pins newest-pinned first, then
// the rest by activity.

/** The fields the order reads. `pinnedAt` and `sortOrder` may arrive as `null` from a `thread.updated`. */
export interface Orderable {
  pinnedAt?: number | null
  sortOrder?: number | null
  lastActivity?: number
}

/** True when the thread is pinned to the top. */
export function isPinned(t: Orderable): boolean {
  return typeof t.pinnedAt === 'number' && t.pinnedAt > 0
}

/** True when the user placed the thread by dragging (it has a manual place). */
export function isPlaced(t: Orderable): boolean {
  return typeof t.sortOrder === 'number' && Number.isFinite(t.sortOrder)
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

const byActivity = (a: Orderable, b: Orderable) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)

/** The thread-list order (see the rule at the top of this file). */
export function compareThreads(a: Orderable, b: Orderable): number {
  const pinned = isPinned(a)
  if (pinned !== isPinned(b)) return pinned ? -1 : 1
  const placed = isPlaced(a)
  if (placed !== isPlaced(b)) return placed ? 1 : -1
  if (placed) return (a.sortOrder as number) - (b.sortOrder as number) || byActivity(a, b)
  return (pinned ? comparePins(a, b) : 0) || byActivity(a, b)
}

/** The fields `isListed` reads. */
export interface Listable {
  presence?: string | null
  archived?: boolean
}

/**
 * True when a user-facing thread list (header picker, Overview, Cmd+K) shows
 * the thread. Archived threads are left out, and so is the internal presence
 * thread: the agent's background thread, which the user never chats in and
 * which otherwise reads as a second copy of the main presence chat.
 * System → Agents lists every thread and does not use this.
 */
export function isListed(t: Listable): boolean {
  return !t.archived && t.presence !== 'internal'
}

/** The threads of `list` a user-facing thread list shows, in thread-list order. */
export function listedThreads<T extends Orderable & Listable>(list: readonly T[]): T[] {
  return sortThreads(list.filter(isListed))
}

/** A sorted copy of `list` in thread-list order. */
export function sortThreads<T extends Orderable>(list: readonly T[]): T[] {
  return [...list].sort(compareThreads)
}
