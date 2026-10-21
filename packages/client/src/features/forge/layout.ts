// Forge layout — pure: nodes + edges + streams in, world coordinates out.
//
// X is time in three zones around a fixed "now" divider at x = 0:
//   past    (x < 0)  closed/merged items, right edge at their close date;
//   present (x > 0)  open changes and live branches, in columns by last
//                    activity (stale at the divider, fresh towards the future);
//                    stacked changes chain left → right along their base edges;
//   future  (right)  issues, plans and planned tasks, in columns by dependency
//                    depth, then by creation;
//   tree    (far right) the goal tree: one card per work stream, a column per
//                    tree depth, roots furthest right, so the tree breaks down
//                    right → left from the goals towards the work near now.
//                    A plan's stream uses the plan node as its card; a
//                    hand-made stream gets a synthetic card (`epic:<id>`).
// Y is lanes: one per work stream that owns items (a node's owning one; with
// "Owned + related", a related one when no lane stream owns it) in tree order,
// so a subtree's lanes stay together, plus a compact lane for a leaf stream
// with no items; then one per repo for items in no stream, then "Other". A
// stream card sits at the vertical centre of its subtree's lanes. Within a lane
// each unit (a node with its branch line, or a stack) packs into the first row
// it fits, so nothing overlaps.
//
// Every sort ends on the id, so the same graph always gives the same layout.

import type { WorkEdge, WorkNode, WorkStream, Zone } from '@sovereign/core'

export const DAY_MS = 86_400_000
export const PX_PER_DAY = 160
export const NODE_W = 200
export const NODE_H = 44
export const ROW_H = 60
export const LANE_HEAD = 26
export const LANE_PAD = 14
export const COL_W = 240
/** Gap between the "now" divider and the first present column. */
export const NOW_GAP = 60
/** Past nodes end at least this far left of the divider. */
export const PAST_GAP = 24
/** Gap between the present and future zones. */
export const ZONE_GAP = 80
/** Minimum horizontal space between two units sharing a row. */
export const UNIT_GAP = 16
/** A future depth column wraps into sub-columns past this many rows (or the lane's own row count, if larger). */
export const MIN_FUTURE_ROWS = 6
/** Present columns by last activity: older than 21 d, ≤ 21 d, ≤ 7 d, ≤ 3 d, ≤ 1 d. */
export const ACTIVITY_BUCKETS_DAYS = [21, 7, 3, 1]
export const PRESENT_MIN_COLS = ACTIVITY_BUCKETS_DAYS.length + 1

export interface PlacedNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  lane: string
  row: number
  zone: Zone
  /** Future zone only: dependency depth. */
  depth?: number
  /** In the lane of an epic it is only related to (not owned by): drawn with a related cue. */
  related?: true
  /** A goal-tree card: the id of the work stream it stands for (`depth` is then its tree depth, 0 = a root). */
  stream?: string
}

export interface Lane {
  id: string
  label: string
  kind: 'stream' | 'repo' | 'other'
  y: number
  h: number
  rows: number
  /** A leaf stream with no items: one card tall, there only to hold its card. */
  empty?: true
}

/** A goal-tree connector: child card → parent card. */
export interface TreeLink {
  from: string
  to: string
}

/** A branch drawn as a horizontal line from its fork point to its change. */
export interface BranchLine {
  nodeId: string
  lane: string
  y: number
  x0: number
  x1: number
  /** The fork lies before the loaded window: drawn with an "older" marker. */
  clipped: boolean
}

export interface Layout {
  nodes: Map<string, PlacedNode>
  lanes: Lane[]
  branches: BranchLine[]
  /** Edges with both ends placed, endpoints resolved through `alias`, deduped and sorted. */
  edges: WorkEdge[]
  /** Branch nodes drawn as their change: branch id → change id. */
  alias: Map<string, string>
  presentStart: number
  futureStart: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  now: number
  /** The goal tree: card id → the stream it stands for, and the child → parent connectors. */
  tree: { cards: Map<string, WorkStream>; links: TreeLink[] }
}

export interface LayoutInput {
  nodes: WorkNode[]
  edges: WorkEdge[]
  /** The streams the canvas draws as lanes and tree cards; one whose parent is not listed is a root. */
  workstreams: WorkStream[]
  /** ms epoch the "now" divider stands for. */
  now: number
  /** ms epoch of the loaded window's start; branch lines older than this are clipped. */
  since?: number
  /** "Owned + related": a node no lane stream owns goes to the lane of one it is related to. */
  related?: boolean
}

const CARD_PREFIX = 'epic:'
/** The id of a hand-made stream's synthetic tree card. */
export const streamCardId = (streamId: string): string => CARD_PREFIX + streamId
/** The stream a synthetic tree card stands for; null for any other id (a plan card is its plan node). */
export const streamOfCard = (id: string): string | null =>
  id.startsWith(CARD_PREFIX) ? id.slice(CARD_PREFIX.length) : null

export function timeToX(t: number, now: number): number {
  return ((t - now) / DAY_MS) * PX_PER_DAY
}

export function xToTime(x: number, now: number): number {
  return now + (x / PX_PER_DAY) * DAY_MS
}

const ms = (iso: string | undefined): number => {
  if (!iso) return NaN
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : NaN
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The last-activity column a present unit wants (0 = stale, next to "now"). */
export function activityColumn(updatedAt: number, now: number): number {
  const age = (now - updatedAt) / DAY_MS
  let col = 0
  for (const days of ACTIVITY_BUCKETS_DAYS) if (age <= days) col++
  return col
}

/** Streams in tree order: parents before children, siblings as the server lists them. */
export function orderStreams(streams: WorkStream[]): WorkStream[] {
  return streamTree(streams).order
}

export interface StreamTree {
  /** Depth-first, parents before children, siblings in input order. */
  order: WorkStream[]
  /** 0 for a root. */
  depth: Map<string, number>
  /** Child → parent, within the list; a parent outside it or a cycle makes a root. */
  parent: Map<string, string>
  /** Parent → children, in order. */
  children: Map<string, string[]>
}

/** The tree the listed streams form among themselves. */
export function streamTree(streams: WorkStream[]): StreamTree {
  const ids = new Set(streams.map((s) => s.id))
  const kids = new Map<string, WorkStream[]>()
  const roots: WorkStream[] = []
  for (const s of streams) {
    if (s.parentId && ids.has(s.parentId) && s.parentId !== s.id) {
      const list = kids.get(s.parentId) ?? []
      list.push(s)
      kids.set(s.parentId, list)
    } else roots.push(s)
  }
  const order: WorkStream[] = []
  const depth = new Map<string, number>()
  const parent = new Map<string, string>()
  const children = new Map<string, string[]>()
  const walk = (s: WorkStream, d: number, from?: string): void => {
    if (depth.has(s.id)) return
    depth.set(s.id, d)
    if (from) {
      parent.set(s.id, from)
      children.set(from, [...(children.get(from) ?? []), s.id])
    }
    order.push(s)
    for (const c of kids.get(s.id) ?? []) walk(c, d + 1, s.id)
  }
  for (const r of roots) walk(r, 0)
  // A parent cycle leaves streams unreached; the first of each becomes a root.
  for (const s of streams) walk(s, 0)
  return { order, depth, parent, children }
}

function laneOf(node: WorkNode, streamRank: Map<string, number>, related: boolean): string {
  const first = (ids: string[]): string | undefined => {
    let best: string | undefined
    let bestRank = Infinity
    for (const s of ids) {
      const r = streamRank.get(s)
      if (r !== undefined && r < bestRank) {
        bestRank = r
        best = s
      }
    }
    return best
  }
  const best = first(node.workstreams) ?? (related ? first(node.relatedStreams ?? []) : undefined)
  if (best) return `stream:${best}`
  if (node.repo) return `repo:${node.repo}`
  return 'other'
}

/** The node sits in the lane of an epic it is related to but not owned by. */
const relatedIn = (n: WorkNode, lane: string): boolean => {
  if (!lane.startsWith('stream:')) return false
  const id = lane.slice('stream:'.length)
  return !n.workstreams.includes(id) && (n.relatedStreams ?? []).includes(id)
}

/** Branch nodes that are the head of a change in the same repo collapse into that change. */
export function branchAliases(nodes: WorkNode[]): Map<string, string> {
  const heads = new Map<string, string>()
  for (const n of [...nodes].sort(byId)) {
    if (n.kind !== 'change' || !n.branch?.head) continue
    const key = `${n.repo ?? ''}\u0000${n.branch.head}`
    const prev = heads.get(key)
    // Several changes from one branch: the open one, else the newest, owns it.
    if (!prev) heads.set(key, n.id)
    else {
      const p = nodes.find((x) => x.id === prev)!
      const better =
        (n.zone !== 'past' && p.zone === 'past') || (n.zone === p.zone && ms(n.updatedAt) > ms(p.updatedAt))
      if (better) heads.set(key, n.id)
    }
  }
  const alias = new Map<string, string>()
  for (const n of nodes) {
    if (n.kind !== 'branch') continue
    const name = n.branch?.head ?? n.title
    const owner = heads.get(`${n.repo ?? ''}\u0000${name}`)
    if (owner) alias.set(n.id, owner)
  }
  return alias
}

/** Edge kinds that order the future zone: from comes before (left of) to. */
const DEPTH_KINDS = new Set<WorkEdge['kind']>(['plans', 'subtask', 'references', 'closes', 'related', 'base'])

/** Longest-path depth over future nodes; nodes in a cycle keep the depth reached before it. */
export function futureDepths(nodes: WorkNode[], edges: WorkEdge[]): Map<string, number> {
  const ids = new Set(nodes.filter((n) => n.zone === 'future').map((n) => n.id))
  const out = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) indeg.set(id, 0)
  const seenPair = new Set<string>()
  for (const e of [...edges].sort(edgeOrder)) {
    if (!DEPTH_KINDS.has(e.kind) || !ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue
    const pair = `${e.from}\u0000${e.to}`
    if (seenPair.has(pair)) continue
    seenPair.add(pair)
    const list = out.get(e.from) ?? []
    list.push(e.to)
    out.set(e.from, list)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const depth = new Map<string, number>()
  for (const id of ids) depth.set(id, 0)
  const queue = [...ids].filter((id) => indeg.get(id) === 0).sort()
  while (queue.length) {
    const id = queue.shift()!
    for (const to of out.get(id) ?? []) {
      depth.set(to, Math.max(depth.get(to)!, depth.get(id)! + 1))
      const d = indeg.get(to)! - 1
      indeg.set(to, d)
      if (d === 0) queue.push(to)
    }
  }
  return depth
}

function edgeOrder(a: WorkEdge, b: WorkEdge): number {
  return a.from < b.from
    ? -1
    : a.from > b.from
      ? 1
      : a.to < b.to
        ? -1
        : a.to > b.to
          ? 1
          : a.kind < b.kind
            ? -1
            : a.kind > b.kind
              ? 1
              : 0
}

interface Unit {
  /** Node ids left → right. */
  ids: string[]
  lane: string
  /** x of the first node; set before packing. */
  x: number
  /** Leftmost x the unit occupies (its branch line's fork, clipped). */
  start: number
  end: number
  fork?: { x: number; clipped: boolean }
  sortKey: number
}

export function computeLayout(input: LayoutInput): Layout {
  const { now } = input
  const clipX = input.since !== undefined ? timeToX(input.since, now) : -Infinity
  const nodes = [...input.nodes].sort(byId)
  const alias = branchAliases(nodes)
  const nodeById = new Map(nodes.filter((n) => !alias.has(n.id)).map((n) => [n.id, n]))

  const tree = streamTree(input.workstreams)
  const streams = tree.order
  // Tree cards: a plan's stream takes its plan node (when loaded), any other stream a synthetic card.
  const cardOf = new Map<string, string>()
  const cards = new Map<string, WorkStream>()
  for (const s of streams) {
    const id = s.plan && nodeById.has(s.plan) && !cards.has(s.plan) ? s.plan : streamCardId(s.id)
    cardOf.set(s.id, id)
    cards.set(id, s)
  }
  // Everything else lives on the timeline.
  const live = [...nodeById.values()].filter((n) => !cards.has(n.id))

  const streamRank = new Map(streams.map((s, i) => [s.id, i]))
  const laneById = new Map<string, string>()
  for (const n of live) laneById.set(n.id, laneOf(n, streamRank, input.related === true))
  // A stack lives in its root's lane: an open change follows its open base
  // change down the base edges, whatever other streams it belongs to.
  {
    const openBase = new Map<string, string>()
    for (const e of input.edges) {
      if (e.kind !== 'base') continue
      const from = alias.get(e.from) ?? e.from
      const to = alias.get(e.to) ?? e.to
      if (from !== to && nodeById.get(from)?.zone === 'present' && nodeById.get(to)?.zone === 'present')
        openBase.set(from, to)
    }
    for (const id of openBase.keys()) {
      let root = id
      const seen = new Set([id])
      while (openBase.has(root) && !seen.has(openBase.get(root)!)) seen.add((root = openBase.get(root)!))
      laneById.set(id, laneById.get(root)!)
    }
  }

  const units: Unit[] = []
  const forkOf = (n: WorkNode, nodeX: number): { x: number; clipped: boolean } | undefined => {
    if (n.kind !== 'change' && n.kind !== 'branch') return undefined
    const t = ms(n.createdAt)
    if (!Number.isFinite(t)) return undefined
    const fx = Math.min(timeToX(t, now), nodeX)
    return fx < clipX ? { x: clipX, clipped: true } : { x: fx, clipped: false }
  }

  // ── Past: right edge at the close date. ────────────────────────────
  for (const n of live) {
    if (n.zone !== 'past') continue
    const t = ms(n.closedAt) || ms(n.updatedAt) || ms(n.createdAt) || now
    const x = Math.min(timeToX(t, now), -PAST_GAP) - NODE_W
    const fork = forkOf(n, x)
    units.push({
      ids: [n.id],
      lane: laneById.get(n.id)!,
      x,
      start: fork ? Math.min(fork.x, x) : x,
      end: x + NODE_W,
      fork,
      sortKey: t
    })
  }

  // ── Present: stacks as chains along base edges. ────────────────────
  const present = live.filter((n) => n.zone === 'present')
  const presentIds = new Set(present.map((n) => n.id))
  const resolve = (id: string): string => alias.get(id) ?? id
  // child (head change) → its base change, same lane only.
  const baseOf = new Map<string, string>()
  for (const e of [...input.edges].sort(edgeOrder)) {
    if (e.kind !== 'base') continue
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (from === to || !presentIds.has(from) || !presentIds.has(to)) continue
    if (laneById.get(from) !== laneById.get(to) || baseOf.has(from)) continue
    // Refuse a link that would close a cycle.
    let cur: string | undefined = to
    let cycle = false
    while (cur) {
      if (cur === from) {
        cycle = true
        break
      }
      cur = baseOf.get(cur)
    }
    if (!cycle) baseOf.set(from, to)
  }
  const kids = new Map<string, string[]>()
  for (const [child, base] of baseOf) {
    const list = kids.get(base) ?? []
    list.push(child)
    kids.set(base, list)
  }
  const createdOf = (id: string): number => ms(nodeById.get(id)!.createdAt) || 0
  const activityOf = (id: string): number => {
    const n = nodeById.get(id)!
    return ms(n.updatedAt) || ms(n.createdAt) || now
  }
  for (const list of kids.values()) list.sort((a, b) => createdOf(a) - createdOf(b) || (a < b ? -1 : 1))

  // Linear chains: the first child continues its parent's chain; others start their own,
  // at least one column right of their base.
  const chains: { ids: string[]; minCol: number; parent?: string }[] = []
  const roots = present.filter((n) => !baseOf.has(n.id)).map((n) => n.id)
  const pending: { id: string; parent?: string }[] = roots.map((id) => ({ id }))
  while (pending.length) {
    const { id: head, parent } = pending.shift()!
    const ids: string[] = []
    let cur: string | undefined = head
    while (cur) {
      ids.push(cur)
      const ch: string[] = kids.get(cur) ?? []
      for (const other of ch.slice(1)) pending.push({ id: other, parent: cur })
      cur = ch[0]
    }
    chains.push({ ids, minCol: 0, parent })
  }
  const colOf = new Map<string, number>()
  // Parents are placed before the chains that branch off them (queue order).
  let presentCols = PRESENT_MIN_COLS
  for (const chain of chains) {
    const minCol = chain.parent !== undefined ? (colOf.get(chain.parent) ?? 0) + 1 : 0
    const lastActivity = Math.max(...chain.ids.map(activityOf))
    const startCol = Math.max(minCol, activityColumn(lastActivity, now) - (chain.ids.length - 1))
    chain.ids.forEach((id, i) => colOf.set(id, startCol + i))
    presentCols = Math.max(presentCols, startCol + chain.ids.length)
    const x = NOW_GAP + startCol * COL_W
    const first = nodeById.get(chain.ids[0])!
    const fork = chain.parent === undefined ? forkOf(first, x) : undefined
    units.push({
      ids: chain.ids,
      lane: laneById.get(chain.ids[0])!,
      x,
      start: fork ? Math.min(fork.x, x) : x,
      end: x + (chain.ids.length - 1) * COL_W + NODE_W,
      fork,
      sortKey: lastActivity
    })
  }
  const presentStart = NOW_GAP
  const futureStart = NOW_GAP + presentCols * COL_W + ZONE_GAP

  // ── Pack past + present units into rows per lane. ──────────────────
  const rowsByLane = new Map<string, number[]>()
  const placed = new Map<string, PlacedNode>()
  const branches: BranchLine[] = []
  const rowOfUnit = new Map<Unit, number>()
  const sortedUnits = [...units].sort(
    (a, b) => a.start - b.start || a.x - b.x || (a.ids[0] < b.ids[0] ? -1 : a.ids[0] > b.ids[0] ? 1 : 0)
  )
  for (const u of sortedUnits) {
    const rows = rowsByLane.get(u.lane) ?? []
    let row = rows.findIndex((end) => end + UNIT_GAP <= u.start)
    if (row === -1) {
      row = rows.length
      rows.push(u.end)
    } else rows[row] = u.end
    rowsByLane.set(u.lane, rows)
    rowOfUnit.set(u, row)
  }

  // ── Future: depth columns, wrapped into sub-columns. ───────────────
  const depth = futureDepths(live, input.edges)
  const futureByLane = new Map<string, WorkNode[]>()
  for (const n of live) {
    if (n.zone !== 'future') continue
    const lane = laneById.get(n.id)!
    const list = futureByLane.get(lane) ?? []
    list.push(n)
    futureByLane.set(lane, list)
  }
  const futureRows = new Map<string, number>()
  const futureCells = new Map<string, { x: number; row: number; depth: number }>()
  for (const [lane, list] of futureByLane) {
    const target = Math.max(rowsByLane.get(lane)?.length ?? 0, MIN_FUTURE_ROWS)
    const groups = new Map<number, WorkNode[]>()
    for (const n of list) {
      const d = depth.get(n.id) ?? 0
      const g = groups.get(d) ?? []
      g.push(n)
      groups.set(d, g)
    }
    let colOffset = 0
    let usedRows = 0
    for (const d of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups
        .get(d)!
        .sort((a, b) => (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      g.forEach((n, i) => {
        const sub = Math.floor(i / target)
        futureCells.set(n.id, { x: futureStart + (colOffset + sub) * COL_W, row: i % target, depth: d })
      })
      colOffset += Math.ceil(g.length / target)
      usedRows = Math.max(usedRows, Math.min(g.length, target))
    }
    futureRows.set(lane, usedRows)
  }

  // ── Lanes, top to bottom. ──────────────────────────────────────────
  const laneIds = new Set<string>(laneById.values())
  const ordered: { id: string; label: string; kind: Lane['kind']; empty?: true }[] = []
  for (const s of streams) {
    const id = `stream:${s.id}`
    if (laneIds.has(id)) ordered.push({ id, label: s.name, kind: 'stream' })
    // A leaf stream with no items keeps a compact lane, so its card has a place.
    else if (!tree.children.has(s.id)) ordered.push({ id, label: s.name, kind: 'stream', empty: true })
  }
  for (const id of [...laneIds].filter((l) => l.startsWith('repo:')).sort())
    ordered.push({ id, label: id.slice(5), kind: 'repo' })
  if (laneIds.has('other')) ordered.push({ id: 'other', label: 'Other', kind: 'other' })

  const lanes: Lane[] = []
  const laneTop = new Map<string, number>()
  let y = 0
  for (const l of ordered) {
    const rows = l.empty ? 0 : Math.max(rowsByLane.get(l.id)?.length ?? 0, futureRows.get(l.id) ?? 0, 1)
    const h = l.empty ? ROW_H : LANE_HEAD + rows * ROW_H + LANE_PAD
    lanes.push({ ...l, y, h, rows })
    laneTop.set(l.id, y)
    y += h
  }
  const rowY = (lane: string, row: number): number =>
    laneTop.get(lane)! + LANE_HEAD + row * ROW_H + (ROW_H - NODE_H) / 2

  for (const u of units) {
    const row = rowOfUnit.get(u)!
    u.ids.forEach((id, i) => {
      const n = nodeById.get(id)!
      placed.set(id, {
        id,
        x: u.x + i * COL_W,
        y: rowY(u.lane, row),
        w: NODE_W,
        h: NODE_H,
        lane: u.lane,
        row,
        zone: n.zone,
        ...(relatedIn(n, u.lane) ? { related: true as const } : {})
      })
    })
    if (u.fork && u.fork.x < u.x) {
      branches.push({
        nodeId: u.ids[0],
        lane: u.lane,
        y: rowY(u.lane, row) + NODE_H / 2,
        x0: u.fork.x,
        x1: u.x,
        clipped: u.fork.clipped
      })
    }
  }
  for (const [id, cell] of futureCells) {
    const lane = laneById.get(id)!
    placed.set(id, {
      id,
      x: cell.x,
      y: rowY(lane, cell.row),
      w: NODE_W,
      h: NODE_H,
      lane,
      row: cell.row,
      zone: 'future',
      depth: cell.depth,
      ...(relatedIn(nodeById.get(id)!, lane) ? { related: true as const } : {})
    })
  }
  branches.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))

  // ── Goal tree: a column per depth right of the future zone, roots furthest right. ──
  const links: TreeLink[] = []
  if (streams.length) {
    let futureEnd = -Infinity
    for (const cell of futureCells.values()) futureEnd = Math.max(futureEnd, cell.x + NODE_W)
    const treeStart = Number.isFinite(futureEnd) ? futureEnd + ZONE_GAP : futureStart
    const maxDepth = Math.max(...tree.depth.values())
    const laneAt = new Map(lanes.map((l) => [l.id, l]))
    // A stream's subtree spans its own lane (if any) and its descendants' lanes: contiguous, in tree order.
    const spans = new Map<string, { top: number; bottom: number; lane: string }>()
    const spanOf = (id: string): { top: number; bottom: number; lane: string } => {
      const known = spans.get(id)
      if (known) return known
      const own = laneAt.get(`stream:${id}`)
      let top = own ? own.y : Infinity
      let bottom = own ? own.y + own.h : -Infinity
      let lane = own?.id
      for (const c of tree.children.get(id) ?? []) {
        const cs = spanOf(c)
        top = Math.min(top, cs.top)
        bottom = Math.max(bottom, cs.bottom)
        lane ??= cs.lane
      }
      const span = { top, bottom, lane: lane! }
      spans.set(id, span)
      return span
    }
    for (const s of streams) {
      const id = cardOf.get(s.id)!
      const d = tree.depth.get(s.id)!
      const span = spanOf(s.id)
      placed.set(id, {
        id,
        x: treeStart + (maxDepth - d) * COL_W,
        y: (span.top + span.bottom) / 2 - NODE_H / 2,
        w: NODE_W,
        h: NODE_H,
        lane: span.lane,
        row: 0,
        zone: 'future',
        depth: d,
        stream: s.id
      })
      const parent = tree.parent.get(s.id)
      if (parent) links.push({ from: id, to: cardOf.get(parent)! })
    }
  }

  // ── Edges through aliases, both ends placed. ───────────────────────
  const seen = new Set<string>()
  const edges: WorkEdge[] = []
  for (const e of [...input.edges].sort(edgeOrder)) {
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (from === to || !placed.has(from) || !placed.has(to)) continue
    const key = `${from}\u0000${to}\u0000${e.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push(from === e.from && to === e.to ? e : { ...e, from, to })
  }

  let minX = 0
  let maxX = futureStart
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x + p.w)
  }
  for (const b of branches) minX = Math.min(minX, b.x0)
  return {
    nodes: placed,
    lanes,
    branches,
    edges,
    alias,
    presentStart,
    futureStart,
    bounds: { minX, maxX, minY: 0, maxY: y },
    now,
    tree: { cards, links }
  }
}

/** Rectangles overlap (strictly, touching edges do not count). */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
