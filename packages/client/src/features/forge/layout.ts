// Forge layout — pure: nodes + edges + streams in, world coordinates out.
//
// X is time in three zones around a fixed "now" divider at x = 0:
//   past    (x < 0)  closed/merged items, right edge at their close date;
//   present (x > 0)  open changes and live branches, in columns by last
//                    activity (stale at the divider, fresh towards the future);
//                    stacked changes chain left → right along their base edges;
//   future  (right)  issues, plans and planned tasks, in columns by dependency depth
//                    (wrapped to the height the past and present need);
//   tree    (far right) the goal tree: one card per work stream, a column per
//                    tree depth, roots furthest right, so the tree breaks down
//                    right → left from the goals towards the work near now.
//                    A plan's stream uses the plan node as its card; a
//                    hand-made stream gets a synthetic card (`epic:<id>`).
// Y comes from the connections, on one grid of rows. Each item links to the card
// of the stream that owns it (`tree.members`). Items start grouped in tree order;
// then each pass moves every unit (a node with its branch line, or a stack)
// towards the mean height of its card and its edge neighbours, and packs it into
// the free row nearest that height, so connected work sits together and lines
// cross as little as the time axis allows. A card sits at the mean height of its
// items and child cards; cards in one column never overlap.
//
// Every sort ends on the id, so the same graph always gives the same layout.

import type { WorkEdge, WorkNode, WorkStream, Zone } from '@sovereign/core'

export const DAY_MS = 86_400_000
export const PX_PER_DAY = 160
export const NODE_W = 200
export const NODE_H = 44
export const ROW_H = 60
export const COL_W = 240
/** Gap between the "now" divider and the first present column. */
export const NOW_GAP = 60
/** Past nodes end at least this far left of the divider. */
export const PAST_GAP = 24
/** Gap between the present and future zones. */
export const ZONE_GAP = 80
/** Minimum horizontal space between two units sharing a row. */
export const UNIT_GAP = 16
/** Minimum vertical space between two cards of one tree column. */
export const CARD_GAP = 16
/** A future depth column wraps into sub-columns past this many rows (or the rows the past and present need, if more). */
export const MIN_FUTURE_ROWS = 6
/** Passes that pull units towards their connections. */
export const LAYOUT_PASSES = 4
/** Present columns by last activity: older than 21 d, ≤ 21 d, ≤ 7 d, ≤ 3 d, ≤ 1 d. */
export const ACTIVITY_BUCKETS_DAYS = [21, 7, 3, 1]
export const PRESENT_MIN_COLS = ACTIVITY_BUCKETS_DAYS.length + 1

export interface PlacedNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** What the node belongs to: `stream:<id>` (its owning stream on the canvas), `repo:<owner/name>` or `other`. */
  group: string
  /** Row on the shared grid (0 for a tree card). */
  row: number
  zone: Zone
  /** Future zone only: dependency depth. */
  depth?: number
  /** In the group of an epic it is only related to (not owned by): drawn with a related cue. */
  related?: true
  /** A goal-tree card: the id of the work stream it stands for (`depth` is then its tree depth, 0 = a root). */
  stream?: string
}

/** A goal-tree connector: child card → parent card. */
export interface TreeLink {
  from: string
  to: string
}

/** An item → the card of the stream it belongs to (`related`: only related, with "Owned + related"). */
export interface MemberLink {
  from: string
  to: string
  related?: true
}

/** A branch drawn as a horizontal line from its fork point to its change. */
export interface BranchLine {
  nodeId: string
  y: number
  x0: number
  x1: number
  /** The fork lies before the loaded window: drawn with an "older" marker. */
  clipped: boolean
}

export interface Layout {
  nodes: Map<string, PlacedNode>
  branches: BranchLine[]
  /** Edges with both ends placed, endpoints resolved through `alias`, deduped and sorted. */
  edges: WorkEdge[]
  /** Branch nodes drawn as their change: branch id → change id. */
  alias: Map<string, string>
  presentStart: number
  futureStart: number
  bounds: { minX: number; maxX: number; minY: number; maxY: number }
  now: number
  /** The goal tree: card id → the stream it stands for, child → parent connectors, item → card connectors. */
  tree: { cards: Map<string, WorkStream>; links: TreeLink[]; members: MemberLink[] }
}

export interface LayoutInput {
  nodes: WorkNode[]
  edges: WorkEdge[]
  /** The streams the canvas draws as tree cards; one whose parent is not listed is a root. */
  workstreams: WorkStream[]
  /** ms epoch the "now" divider stands for. */
  now: number
  /** ms epoch of the loaded window's start; branch lines older than this are clipped. */
  since?: number
  /** "Owned + related": a node no drawn stream owns belongs to one it is related to. */
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

function groupOf(node: WorkNode, streamRank: Map<string, number>, related: boolean): string {
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

/** The node belongs to an epic it is related to but not owned by. */
const relatedIn = (n: WorkNode, group: string): boolean => {
  if (!group.startsWith('stream:')) return false
  const id = group.slice('stream:'.length)
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
  group: string
  /** x of the first node. */
  x: number
  /** Leftmost x the unit occupies (its branch line's fork, clipped). */
  start: number
  end: number
  fork?: { x: number; clipped: boolean }
  /** Its row on the grid; set by packing. */
  row: number
}

/** The shared row grid: each row holds the [start, end] spans of its units, so units never overlap. */
class Grid {
  private rows: Array<Array<[number, number]>> = []
  private fits(r: number, u: Unit): boolean {
    return (this.rows[r] ?? []).every(([s, e]) => u.end + UNIT_GAP <= s || e + UNIT_GAP <= u.start)
  }
  /** Put the unit in the free row nearest `want` (below wins a tie), never above row 0. */
  place(u: Unit, want: number): number {
    const at = Math.max(0, Math.round(want))
    for (let d = 0; ; d++) {
      for (const r of d ? [at + d, at - d] : [at]) {
        if (r < 0 || !this.fits(r, u)) continue
        ;(this.rows[r] ??= []).push([u.start, u.end])
        return r
      }
    }
  }
  /** The lowest free row at or below `from`, for the first fill. */
  placeFrom(u: Unit, from: number): number {
    for (let r = from; ; r++) {
      if (!this.fits(r, u)) continue
      ;(this.rows[r] ??= []).push([u.start, u.end])
      return r
    }
  }
  get height(): number {
    return this.rows.length
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

export function computeLayout(input: LayoutInput): Layout {
  const { now } = input
  const clipX = input.since !== undefined ? timeToX(input.since, now) : -Infinity
  const nodes = [...input.nodes].sort(byId)
  const alias = branchAliases(nodes)
  const nodeById = new Map(nodes.filter((n) => !alias.has(n.id)).map((n) => [n.id, n]))
  const resolve = (id: string): string => alias.get(id) ?? id

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
  const groupById = new Map<string, string>()
  for (const n of live) groupById.set(n.id, groupOf(n, streamRank, input.related === true))
  // A stack belongs with its root: an open change follows its open base change
  // down the base edges, whatever other streams it belongs to.
  {
    const openBase = new Map<string, string>()
    for (const e of input.edges) {
      if (e.kind !== 'base') continue
      const from = resolve(e.from)
      const to = resolve(e.to)
      if (from !== to && nodeById.get(from)?.zone === 'present' && nodeById.get(to)?.zone === 'present')
        openBase.set(from, to)
    }
    for (const id of openBase.keys()) {
      let root = id
      const seen = new Set([id])
      while (openBase.has(root) && !seen.has(openBase.get(root)!)) seen.add((root = openBase.get(root)!))
      groupById.set(id, groupById.get(root)!)
    }
  }

  const units: Unit[] = []
  const unit = (ids: string[], x: number, end: number, fork?: { x: number; clipped: boolean }): void => {
    units.push({ ids, group: groupById.get(ids[0])!, x, start: fork ? Math.min(fork.x, x) : x, end, fork, row: 0 })
  }
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
    unit([n.id], x, x + NODE_W, forkOf(n, x))
  }

  // ── Present: stacks as chains along base edges. ────────────────────
  const present = live.filter((n) => n.zone === 'present')
  const presentIds = new Set(present.map((n) => n.id))
  // child (head change) → its base change, within one group only.
  const baseOf = new Map<string, string>()
  for (const e of [...input.edges].sort(edgeOrder)) {
    if (e.kind !== 'base') continue
    const from = resolve(e.from)
    const to = resolve(e.to)
    if (from === to || !presentIds.has(from) || !presentIds.has(to)) continue
    if (groupById.get(from) !== groupById.get(to) || baseOf.has(from)) continue
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
  const chains: { ids: string[]; parent?: string }[] = []
  const pending: { id: string; parent?: string }[] = present.filter((n) => !baseOf.has(n.id)).map((n) => ({ id: n.id }))
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
    chains.push({ ids, parent })
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
    unit(
      chain.ids,
      x,
      x + (chain.ids.length - 1) * COL_W + NODE_W,
      chain.parent === undefined ? forkOf(first, x) : undefined
    )
  }
  const presentStart = NOW_GAP
  const futureStart = NOW_GAP + presentCols * COL_W + ZONE_GAP

  const groupOrder = [
    ...streams.map((s) => `stream:${s.id}`),
    ...[...new Set(groupById.values())].filter((g) => !g.startsWith('stream:')).sort()
  ]
  const groupRank = new Map(groupOrder.map((g, i) => [g, i]))
  const unitOrder = (a: Unit, b: Unit): number =>
    a.start - b.start || a.x - b.x || (a.ids[0] < b.ids[0] ? -1 : a.ids[0] > b.ids[0] ? 1 : 0)

  // ── Future: a column per dependency depth, wrapped to the height the past and present need. ──
  const depth = futureDepths(live, input.edges)
  const needed = new Grid()
  for (const u of [...units].sort(unitOrder)) needed.placeFrom(u, 0)
  const wrap = Math.max(MIN_FUTURE_ROWS, needed.height)
  const byDepth = new Map<number, WorkNode[]>()
  for (const n of live) {
    if (n.zone !== 'future') continue
    const d = depth.get(n.id) ?? 0
    ;(byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(n)
  }
  let colOffset = 0
  for (const d of [...byDepth.keys()].sort((a, b) => a - b)) {
    // A group's items share a sub-column where they can.
    const list = byDepth
      .get(d)!
      .sort(
        (a, b) =>
          groupRank.get(groupById.get(a.id)!)! - groupRank.get(groupById.get(b.id)!)! ||
          (ms(a.createdAt) || 0) - (ms(b.createdAt) || 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      )
    list.forEach((n, i) => {
      const x = futureStart + (colOffset + Math.floor(i / wrap)) * COL_W
      unit([n.id], x, x + NODE_W)
    })
    colOffset += Math.ceil(list.length / wrap)
  }

  // ── Y: the first fill groups units in tree order, then the passes pull each towards its connections. ──
  units.sort((a, b) => (groupRank.get(a.group) ?? 0) - (groupRank.get(b.group) ?? 0) || unitOrder(a, b))
  {
    const grid = new Grid()
    let base = 0
    let group: string | undefined
    for (const u of units) {
      if (u.group !== group) {
        base = grid.height
        group = u.group
      }
      u.row = grid.placeFrom(u, base)
    }
  }

  const unitOf = new Map<string, Unit>()
  for (const u of units) for (const id of u.ids) unitOf.set(id, u)
  // Neighbours along the work graph's edges (between distinct units).
  const neighbours = new Map<Unit, Unit[]>()
  for (const e of [...input.edges].sort(edgeOrder)) {
    const a = unitOf.get(resolve(e.from))
    const b = unitOf.get(resolve(e.to))
    if (!a || !b || a === b) continue
    ;(neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b)
    ;(neighbours.get(b) ?? neighbours.set(b, []).get(b)!).push(a)
  }
  const streamOfGroup = (g: string): string | undefined =>
    g.startsWith('stream:') && cardOf.has(g.slice(7)) ? g.slice(7) : undefined
  const membersOf = new Map<string, Unit[]>()
  for (const u of units) {
    const s = streamOfGroup(u.group)
    if (s) (membersOf.get(s) ?? membersOf.set(s, []).get(s)!).push(u)
  }
  /** Each stream's height in rows: the mean of its members and child streams (bottom-up); NaN with neither. */
  const streamRows = (): Map<string, number> => {
    const at = new Map<string, number>()
    for (const s of [...streams].reverse()) {
      const ys = [
        ...(membersOf.get(s.id) ?? []).map((u) => u.row),
        ...(tree.children.get(s.id) ?? []).map((c) => at.get(c)!).filter((y) => !Number.isNaN(y))
      ]
      at.set(s.id, ys.length ? mean(ys) : NaN)
    }
    return at
  }
  for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
    const at = streamRows()
    const want = new Map<Unit, number>()
    for (const u of units) {
      const s = streamOfGroup(u.group)
      const pulls = (neighbours.get(u) ?? []).map((n) => n.row)
      if (s && !Number.isNaN(at.get(s)!)) pulls.push(at.get(s)!)
      want.set(u, pulls.length ? mean(pulls) : u.row)
    }
    const grid = new Grid()
    for (const u of [...units].sort((a, b) => want.get(a)! - want.get(b)! || a.row - b.row || unitOrder(a, b)))
      u.row = grid.place(u, want.get(u)!)
  }
  // Close the rows the passes left empty; the order stays.
  {
    const used = [...new Set(units.map((u) => u.row))].sort((a, b) => a - b)
    const index = new Map(used.map((r, i) => [r, i]))
    for (const u of units) u.row = index.get(u.row)!
  }

  const rowY = (row: number): number => row * ROW_H + (ROW_H - NODE_H) / 2
  const placed = new Map<string, PlacedNode>()
  const branches: BranchLine[] = []
  for (const u of units) {
    u.ids.forEach((id, i) => {
      const n = nodeById.get(id)!
      placed.set(id, {
        id,
        x: u.x + i * COL_W,
        y: rowY(u.row),
        w: NODE_W,
        h: NODE_H,
        group: u.group,
        row: u.row,
        zone: n.zone,
        ...(n.zone === 'future' ? { depth: depth.get(id) ?? 0 } : {}),
        ...(relatedIn(n, u.group) ? { related: true as const } : {})
      })
    })
    if (u.fork && u.fork.x < u.x)
      branches.push({ nodeId: u.ids[0], y: rowY(u.row) + NODE_H / 2, x0: u.fork.x, x1: u.x, clipped: u.fork.clipped })
  }
  branches.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))

  // ── Goal tree: a column per depth right of the future zone, roots furthest right. ──
  const links: TreeLink[] = []
  const members: MemberLink[] = []
  if (streams.length) {
    let futureEnd = -Infinity
    for (const u of units)
      if (u.ids.some((id) => placed.get(id)!.zone === 'future')) futureEnd = Math.max(futureEnd, u.end)
    const treeStart = Number.isFinite(futureEnd) ? futureEnd + ZONE_GAP : futureStart
    const maxDepth = Math.max(...tree.depth.values())
    // A card wants the centre of its items and child cards; one with neither follows the card before it in tree order.
    const at = streamRows()
    const want = new Map<string, number>()
    let last = 0
    for (const s of streams) {
      const r = at.get(s.id)!
      const y = Number.isNaN(r) ? last + 1 : r
      want.set(s.id, y)
      last = y
    }
    const byColumn = new Map<number, WorkStream[]>()
    for (const s of streams) {
      const d = tree.depth.get(s.id)!
      ;(byColumn.get(d) ?? byColumn.set(d, []).get(d)!).push(s)
    }
    for (const [d, list] of byColumn) {
      let floor = -Infinity
      list.sort((a, b) => want.get(a.id)! - want.get(b.id)! || streamRank.get(a.id)! - streamRank.get(b.id)!)
      for (const s of list) {
        const id = cardOf.get(s.id)!
        const y = Math.max(rowY(want.get(s.id)!), floor)
        floor = y + NODE_H + CARD_GAP
        placed.set(id, {
          id,
          x: treeStart + (maxDepth - d) * COL_W,
          y,
          w: NODE_W,
          h: NODE_H,
          group: `stream:${s.id}`,
          row: 0,
          zone: 'future',
          depth: d,
          stream: s.id
        })
      }
    }
    for (const s of streams) {
      const parent = tree.parent.get(s.id)
      if (parent) links.push({ from: cardOf.get(s.id)!, to: cardOf.get(parent)! })
    }
    for (const u of units) {
      const s = streamOfGroup(u.group)
      if (!s) continue
      for (const id of u.ids) {
        const p = placed.get(id)!
        members.push({ from: id, to: cardOf.get(s)!, ...(p.related ? { related: true as const } : {}) })
      }
    }
    members.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
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
  let maxY = 0
  for (const p of placed.values()) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x + p.w)
    maxY = Math.max(maxY, p.y + p.h + (ROW_H - NODE_H) / 2)
  }
  for (const b of branches) minX = Math.min(minX, b.x0)
  return {
    nodes: placed,
    branches,
    edges,
    alias,
    presentStart,
    futureStart,
    bounds: { minX, maxX, minY: 0, maxY },
    now,
    tree: { cards, links, members }
  }
}

/** Rectangles overlap (strictly, touching edges do not count). */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
