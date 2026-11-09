// Drag to reorder a thread list: the pure parts (where a drop lands, what it
// changes, how the list looks after it). The pointer handling lives in
// thread-drag-controller.ts; the order rule in thread-order.ts.
//
// A drop reorders one group (pinned or not). Dropping across the pinned line
// pins or unpins the thread: dropped among pinned threads (or above the first)
// pins it, among the others (or below the last pinned one, when others follow)
// unpins it. Right on the line between the groups it stays in its own group.

import { isPinned, type Orderable } from './thread-order.js'

export interface DragThread extends Orderable {
  id: string
}

/** What a drop asks the server for: POST /api/threads/reorder. */
export interface ReorderPlan {
  /** The destination group's thread ids, in their new order. */
  ids: string[]
  /** Set when the dragged thread changes group: true pins it, false unpins it. */
  pinned?: boolean
}

/** A row's vertical extent on screen. */
export interface RowBox {
  top: number
  bottom: number
}

/**
 * The insertion index (0..rows.length) for a pointer at `y`: before the first
 * row whose middle lies below `y`, else after the last.
 */
export function dropIndexAt(rows: readonly RowBox[], y: number): number {
  for (let i = 0; i < rows.length; i++) {
    if (y < (rows[i].top + rows[i].bottom) / 2) return i
  }
  return rows.length
}

/**
 * The reorder that dropping `draggedId` at insertion index `index` of `list`
 * (the order on screen) makes, or null when it changes nothing.
 */
export function planDrop<T extends DragThread>(
  list: readonly T[],
  draggedId: string,
  index: number
): ReorderPlan | null {
  const from = list.findIndex((t) => t.id === draggedId)
  if (from < 0 || list.length < 2) return null
  const dragged = list[from]
  const rest = list.filter((t) => t.id !== draggedId)
  const at = Math.max(0, Math.min(rest.length, index > from ? index - 1 : index))
  // Back where it was: nothing moves, and nothing gets pinned or unpinned.
  if (at === from) return null
  const above = rest[at - 1]
  const below = rest[at]
  const wasPinned = isPinned(dragged)
  let pinned = wasPinned
  if (above && below) pinned = isPinned(above) === isPinned(below) ? isPinned(above) : wasPinned
  else if (above) pinned = isPinned(above)
  else if (below) pinned = isPinned(below)
  const order = [...rest.slice(0, at), dragged, ...rest.slice(at)]
  const ids = order.filter((t) => (t === dragged ? pinned : isPinned(t)) === pinned).map((t) => t.id)
  return pinned === wasPinned ? { ids } : { ids, pinned }
}

/**
 * The `sortOrder` for each position of a reorder. The same rule as the
 * server's `assignSortOrders` (packages/threads/src/sort-order.ts), so the
 * optimistic order matches what the server stores: the threads deal out again
 * the places they held; one with none gets a fresh place just above the lowest.
 */
export function assignSortOrders(current: ReadonlyArray<number | null | undefined>): number[] {
  const held = current.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
  const missing = current.length - held.length
  const lowest = held.length ? held[0] : missing
  const fresh = Array.from({ length: missing }, (_, i) => lowest - missing + i)
  const slots = [...fresh, ...held]
  for (let i = 1; i < slots.length; i++) {
    if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1
  }
  return slots
}

/** `list` with a reorder applied (the optimistic update; mirrors the server's `reorder`). */
export function applyReorder<T extends DragThread>(list: readonly T[], plan: ReorderPlan, now = Date.now()): T[] {
  const byId = new Map(list.map((t) => [t.id, t]))
  const changesGroup = (t: T) => plan.pinned !== undefined && isPinned(t) !== plan.pinned
  const placed = plan.ids.map((id) => byId.get(id)).filter((t): t is T => !!t)
  const slots = assignSortOrders(placed.map((t) => (changesGroup(t) ? undefined : t.sortOrder)))
  const next = new Map<string, T>()
  placed.forEach((t, i) => {
    const pinnedAt = changesGroup(t) ? (plan.pinned ? now : undefined) : t.pinnedAt
    next.set(t.id, { ...t, pinnedAt, sortOrder: slots[i] })
  })
  return list.map((t) => next.get(t.id) ?? t)
}

/** The order fields of the threads a reorder touches, to put back if it fails. */
export type OrderSnapshot = Map<string, Pick<Orderable, 'pinnedAt' | 'sortOrder'>>

export function snapshotOrder(list: readonly DragThread[], ids: readonly string[]): OrderSnapshot {
  const wanted = new Set(ids)
  return new Map(
    list.filter((t) => wanted.has(t.id)).map((t) => [t.id, { pinnedAt: t.pinnedAt, sortOrder: t.sortOrder }])
  )
}

/** `list` with the snapshotted order fields put back (other changes since are kept). */
export function restoreOrder<T extends DragThread>(list: readonly T[], snapshot: OrderSnapshot): T[] {
  return list.map((t) => {
    const was = snapshot.get(t.id)
    return was ? { ...t, pinnedAt: was.pinnedAt, sortOrder: was.sortOrder } : t
  })
}

/**
 * How far to scroll a list this frame while dragging at `y`: within `edge` px of
 * its top or bottom, up to `max` px, faster nearer the edge; 0 elsewhere.
 */
export function autoScrollStep(box: RowBox, y: number, edge = 40, max = 14): number {
  const height = box.bottom - box.top
  const zone = Math.min(edge, height / 3)
  if (zone <= 0) return 0
  if (y < box.top + zone) return -Math.ceil(max * Math.min(1, (box.top + zone - y) / zone))
  if (y > box.bottom - zone) return Math.ceil(max * Math.min(1, (y - (box.bottom - zone)) / zone))
  return 0
}
