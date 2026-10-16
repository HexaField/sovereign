// Progressive disclosure — pure. The client holds one contiguous slice of
// past time, [since, until), plus whatever the present and future zones hold,
// plus pinned search results. Panning past either end of the slice asks for
// the next 21 days on that side; a node cap trims the end farthest from where
// the user looks.

import type { ForgeGraph, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { DAY_MS } from './layout.js'

export const WINDOW_DAYS = 21
export const NODE_CAP = 3000
/** A quiet spell can leave one page empty; this many in a row means the history ends. */
export const EMPTY_PAGES_TO_STOP = 3

export interface WindowState {
  membrane: string
  /** ms epoch; past items closed before this are not loaded. */
  since: number
  /** ms epoch; null = up to now (the live window). */
  until: number | null
  nodes: Map<string, WorkNode>
  edges: WorkEdge[]
  workstreams: WorkStream[]
  /** Search results kept whatever the window. */
  pinned: Set<string>
  /** Older pages in a row that held no past items. */
  emptyOlder: number
  /** EMPTY_PAGES_TO_STOP empty older pages in a row: stop asking for history on pan. */
  exhausted: boolean
  syncing: boolean
  syncOff?: boolean
  lastSyncAt?: string
  identity?: string
}

export interface WindowRequest {
  since: number
  until: number | null
  side: 'initial' | 'older' | 'newer'
}

export function initialRequest(now: number, days = WINDOW_DAYS): WindowRequest {
  return { since: now - days * DAY_MS, until: null, side: 'initial' }
}

export function emptyWindow(membrane: string, now: number, days = WINDOW_DAYS): WindowState {
  return {
    membrane,
    since: now - days * DAY_MS,
    until: null,
    nodes: new Map(),
    edges: [],
    workstreams: [],
    pinned: new Set(),
    emptyOlder: 0,
    exhausted: false,
    syncing: false
  }
}

/** Past time of a node, for windowing: its close date, else its last update. */
export function pastTime(n: WorkNode): number {
  const t = Date.parse(n.closedAt ?? n.updatedAt)
  return Number.isFinite(t) ? t : 0
}

const edgeKey = (e: WorkEdge): string => `${e.from}\u0000${e.to}\u0000${e.kind}`

function mergeEdges(a: WorkEdge[], b: WorkEdge[]): WorkEdge[] {
  const m = new Map<string, WorkEdge>()
  for (const e of a) m.set(edgeKey(e), e)
  for (const e of b) m.set(edgeKey(e), e)
  return [...m.values()]
}

function newer(a: WorkNode, b: WorkNode): WorkNode {
  return Date.parse(b.updatedAt) >= Date.parse(a.updatedAt) ? b : a
}

/**
 * Fold a window response in. 'initial' (also a refetch after forge.updated)
 * replaces the present/future and the newest past slice; 'older'/'newer'
 * extend the slice.
 */
export function applyWindow(state: WindowState, graph: ForgeGraph, req: WindowRequest): WindowState {
  const nodes = new Map(state.nodes)
  let since = state.since
  let until = state.until
  let reset = false
  if (req.side === 'initial') {
    // A slice trimmed short of the live window would leave a gap: start over from the request.
    reset = state.nodes.size === 0 || (state.until !== null && state.until < req.since)
    since = reset ? req.since : Math.min(state.since, req.since)
    until = null
    // Drop what the live window owns, so a node that left it (or vanished) goes too:
    // every non-past node, and every past node inside the requested slice (or all, on a reset).
    for (const [id, n] of nodes) {
      if (state.pinned.has(id)) continue
      if (n.zone !== 'past' || reset || pastTime(n) >= req.since) nodes.delete(id)
    }
  } else if (req.side === 'older') {
    since = Math.min(state.since, req.since)
  } else {
    until = req.until === null || state.until === null ? null : Math.max(state.until, req.until)
  }
  for (const n of graph.nodes) {
    const prev = nodes.get(n.id)
    nodes.set(n.id, prev ? newer(prev, n) : n)
  }
  const emptyOlder =
    req.side === 'older'
      ? graph.nodes.some((n) => n.zone === 'past')
        ? 0
        : state.emptyOlder + 1
      : reset
        ? 0
        : state.emptyOlder
  const kept = req.side === 'initial' ? state.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) : state.edges
  return {
    ...state,
    since,
    until,
    nodes,
    edges: mergeEdges(kept, graph.edges),
    workstreams: graph.workstreams.length || req.side === 'initial' ? graph.workstreams : state.workstreams,
    emptyOlder,
    exhausted: emptyOlder >= EMPTY_PAGES_TO_STOP,
    syncing: graph.syncing,
    syncOff: graph.syncOff,
    lastSyncAt: graph.lastSyncAt ?? state.lastSyncAt,
    identity: graph.identity ?? state.identity
  }
}

/** Search results join the graph pinned: they stay through trims and window changes. */
export function applySearch(state: WindowState, result: { nodes: WorkNode[]; edges: WorkEdge[] }): WindowState {
  const nodes = new Map(state.nodes)
  const pinned = new Set(state.pinned)
  for (const n of result.nodes) {
    const prev = nodes.get(n.id)
    nodes.set(n.id, prev ? newer(prev, n) : n)
    pinned.add(n.id)
  }
  return { ...state, nodes, pinned, edges: mergeEdges(state.edges, result.edges) }
}

export function unpinAll(state: WindowState): WindowState {
  const nodes = new Map(state.nodes)
  for (const id of state.pinned) {
    const n = nodes.get(id)
    if (n && n.zone === 'past' && !inSlice(state, pastTime(n))) nodes.delete(id)
  }
  return { ...state, nodes, pinned: new Set(), edges: state.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) }
}

function inSlice(state: WindowState, t: number): boolean {
  return t >= state.since && (state.until === null || t < state.until)
}

/**
 * What to fetch for a viewport showing past time [viewFrom, viewTo] (ms):
 * the next 21 days beyond whichever end of the slice the view has crossed.
 * Older comes first; null when the view sits inside the slice.
 */
export function nextRequest(
  state: WindowState,
  viewFrom: number,
  viewTo: number,
  now: number,
  days = WINDOW_DAYS
): WindowRequest | null {
  const step = days * DAY_MS
  if (viewFrom < state.since && !state.exhausted) {
    return { since: state.since - step, until: state.since, side: 'older' }
  }
  if (state.until !== null && viewTo > state.until) {
    const until = state.until + step
    return { since: state.until, until: until >= now ? null : until, side: 'newer' }
  }
  return null
}

/** "History" control: widen the slice one step to the left regardless of the view. */
export function widenRequest(state: WindowState, days = WINDOW_DAYS): WindowRequest | null {
  if (state.exhausted) return null
  return { since: state.since - days * DAY_MS, until: state.since, side: 'older' }
}

/**
 * Keep at most `cap` nodes: drop unpinned past nodes farthest from `focus`
 * (ms epoch, the time at the viewport centre) and shrink the slice to match,
 * so panning back there loads them again.
 */
export function trimToCap(state: WindowState, cap: number, focus: number): WindowState {
  if (state.nodes.size <= cap) return state
  const droppable = [...state.nodes.values()]
    .filter((n) => n.zone === 'past' && !state.pinned.has(n.id))
    .sort((a, b) => Math.abs(pastTime(b) - focus) - Math.abs(pastTime(a) - focus) || (a.id < b.id ? -1 : 1))
  const excess = state.nodes.size - cap
  const drop = droppable.slice(0, excess)
  if (!drop.length) return state
  const nodes = new Map(state.nodes)
  let since = state.since
  let until = state.until
  for (const n of drop) {
    nodes.delete(n.id)
    const t = pastTime(n)
    if (t < focus) since = Math.max(since, t + 1)
    else until = until === null ? t : Math.min(until, t)
  }
  // Keep the slice contiguous: drop anything that now falls outside it.
  for (const [id, n] of nodes) {
    if (n.zone !== 'past' || state.pinned.has(id)) continue
    const t = pastTime(n)
    if (t < since || (until !== null && t >= until)) nodes.delete(id)
  }
  return {
    ...state,
    nodes,
    since,
    until,
    emptyOlder: since === state.since ? state.emptyOlder : 0,
    exhausted: state.exhausted && since === state.since,
    edges: state.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to))
  }
}

/** Query string for GET /api/forge. */
export function windowQuery(membrane: string, req: WindowRequest, view?: string): string {
  const p = new URLSearchParams({ membrane })
  if (view) p.set('view', view)
  p.set('since', new Date(req.since).toISOString())
  if (req.until !== null) p.set('until', new Date(req.until).toISOString())
  return p.toString()
}
