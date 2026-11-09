// Manual thread order (drag to reorder): the numbers behind `sortOrder`.
//
// A reorder names the threads of one list group in their new order. The list
// may show only some threads (one workspace, a search), so the group's threads
// reuse the places they already hold: the same numbers, dealt out again in the
// new order. Threads this list does not show keep theirs, and stay where they
// were among the others. A thread with no place yet (never placed by hand, or
// just moved across the pinned line) gets a fresh one just above the lowest.

/**
 * The `sortOrder` for each position of a reorder. `current[i]` is the place the
 * thread now at position `i` holds (undefined: none). Returns strictly
 * increasing integers when the current places are integers.
 */
export function assignSortOrders(current: ReadonlyArray<number | undefined>): number[] {
  const held = current.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  const missing = current.length - held.length
  const lowest = held.length ? held[0] : missing
  const fresh = Array.from({ length: missing }, (_, i) => lowest - missing + i)
  const slots = [...fresh, ...held]
  // Equal places (two lists placed their threads independently) would tie.
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1
  }
  return slots
}
