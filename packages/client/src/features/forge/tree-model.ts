// Goal tree — pure. Work streams form a tree (one parent each): goals at the
// top, nodes below, and each node's leaves are the PRs, issues and task-only
// tasks it owns. The Tree panel lists streams as epics-model orders them; a
// node's leaves stay collapsed until it opens them. Picking a node focuses the
// canvas and Kanban on its subtree (focusedEpics); the canvas then draws that
// subtree as the goal tree, the picked node its right-most root (canvasStreams,
// layout.ts).

import type { ForgeFilters, StreamProgress, WorkNode, WorkStream } from '@sovereign/core'
import { leafState } from '@sovereign/core/forge'
import { orderEpics, pickedEpics, shownEpics, shownStatuses, type EpicRow } from './epics-model.js'
import { EPIC_STATUS_LABELS } from './style.js'

/** Names from the goal down to the stream ("Closed beta", "Auth"); a parent cycle stops at the first repeat. */
export function streamPath(streams: WorkStream[], id: string): string[] {
  const byId = new Map(streams.map((s) => [s.id, s]))
  const out: string[] = []
  const seen = new Set<string>()
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id)
    out.unshift(cur.name)
  }
  return out
}

/** The stream and every stream below it. */
export function subtreeOf(streams: WorkStream[], id: string): Set<string> {
  const out = new Set([id])
  for (let grew = true; grew; ) {
    grew = false
    for (const s of streams) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id)
        grew = true
      }
    }
  }
  return out
}

/** Whether moving `id` under `parentId` (null = the top level) is a move the server accepts: no cycle, not where it sits. */
export function canPlace(streams: WorkStream[], id: string, parentId: string | null): boolean {
  const s = streams.find((x) => x.id === id)
  if (!s) return false
  if (parentId === null) return !!s.parentId
  if (s.parentId === parentId) return false
  return !subtreeOf(streams, id).has(parentId)
}

/** The parents "Move to…" offers, in tree order and named by path: every stream but `id`'s own subtree (all of them for a leaf). */
export function placeOptions(streams: WorkStream[], id?: string): Array<{ id: string; label: string }> {
  const skip = id ? subtreeOf(streams, id) : new Set<string>()
  return orderEpics(streams)
    .filter((r) => !skip.has(r.stream.id))
    .map((r) => ({ id: r.stream.id, label: streamPath(streams, r.stream.id).join(' › ') }))
}

const LEAF_ORDER = { open: 0, done: 1, cancelled: 2 } as const

/** A stream's own leaves among the loaded nodes: open first, then newest. */
export function leavesOf(streamId: string, nodes: WorkNode[]): WorkNode[] {
  return nodes
    .filter((n) => n.workstreams.includes(streamId) && leafState(n) !== undefined)
    .sort(
      (a, b) =>
        LEAF_ORDER[leafState(a)!] - LEAF_ORDER[leafState(b)!] ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id)
    )
}

export type TreeRow =
  | { kind: 'stream'; stream: WorkStream; depth: number; hasChildren: boolean; leaves: number }
  | { kind: 'leaf'; node: WorkNode; depth: number; streamId: string }

/** The outline: stream rows (a collapsed one hides its subtree), each followed by its leaves when opened. */
export function treeRows(
  rows: EpicRow[],
  nodes: WorkNode[],
  state: { collapsed: Set<string>; openLeaves: Set<string> }
): TreeRow[] {
  const parents = new Set(rows.map((r) => r.stream.parentId).filter((p): p is string => !!p))
  const out: TreeRow[] = []
  let hideBelow: number | undefined
  for (const r of rows) {
    if (hideBelow !== undefined) {
      if (r.depth > hideBelow) continue
      hideBelow = undefined
    }
    const leaves = leavesOf(r.stream.id, nodes)
    out.push({
      kind: 'stream',
      stream: r.stream,
      depth: r.depth,
      hasChildren: parents.has(r.stream.id),
      leaves: leaves.length
    })
    if (state.collapsed.has(r.stream.id)) {
      hideBelow = r.depth
      continue
    }
    if (state.openLeaves.has(r.stream.id))
      for (const node of leaves) out.push({ kind: 'leaf', node, depth: r.depth + 1, streamId: r.stream.id })
  }
  return out
}

/** What a node's card shows: the stream, its path, its sub-nodes by name and its own leaves; null when not served. */
export function streamCard(
  streams: WorkStream[],
  id: string,
  nodes: WorkNode[]
): { stream: WorkStream; path: string[]; children: WorkStream[]; leaves: WorkNode[] } | null {
  const stream = streams.find((s) => s.id === id)
  if (!stream) return null
  return {
    stream,
    path: streamPath(streams, id),
    children: orderEpics(streams.filter((s) => s.parentId === id)).map((r) => r.stream),
    leaves: leavesOf(id, nodes)
  }
}

/** "1/6" (done of total leaves over the subtree); "" with no leaves. */
export function progressLabel(p: StreamProgress | undefined): string {
  return p && p.total ? `${p.done}/${p.total}` : ''
}

/** "Tree (12)"; "Tree (2/12)" while two are picked; "Tree: Active, Paused (7)" while statuses select. */
export function treeButtonLabel(f: ForgeFilters, streams: WorkStream[]): string {
  const shown = shownEpics(f, streams).length
  const picked = pickedEpics(f, streams).length
  if (picked) return `Tree (${picked}/${shown})`
  if (f.epicStatus?.length)
    return `Tree: ${shownStatuses(f)
      .map((s) => EPIC_STATUS_LABELS[s])
      .join(', ')} (${shown})`
  return `Tree (${shown})`
}
