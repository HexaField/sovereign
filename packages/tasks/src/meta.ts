// Forge meta store — saved Forge views and the `related` edges agents add
// between work-graph nodes. Same resilience as the task store (durable.ts):
// memory for reads, AD4M for writes, outbox while AD4M is down, snapshot for
// restarts. Files: <dir>/meta-outbox.jsonl, <dir>/meta-snapshot.json.

import { randomUUID } from 'node:crypto'
import type { ForgeFilters, ForgeView } from '@sovereign/core'
import type { DurableBackend, DurableStatus } from './durable.js'
import { createDurable } from './durable.js'
import type { LinkGraph, LinkPattern, LinkTriple } from './link-graph.js'
import { fromLiteral, toLiteral } from './link-graph.js'
import { P, RDF_TYPE, T } from './ontology.js'

export type RelatedEdgeSource = 'sync' | 'rethink' | 'josh'

/** A `related` edge between two work-graph nodes (WorkNode ids). */
export interface RelatedEdge {
  id: string
  from: string
  to: string
  reason: string
  /** 0..1 */
  confidence: number
  source: RelatedEdgeSource
  membrane: string | null
  createdAt: string
}

export interface ForgeMeta {
  views: Map<string, ForgeView>
  edges: Map<string, RelatedEdge>
}

export type ForgeMetaOp =
  | { type: 'view.put'; view: ForgeView }
  | { type: 'view.delete'; id: string }
  | { type: 'edge.put'; edge: RelatedEdge }
  | { type: 'edge.delete'; id: string }

const EDGE_SOURCES: readonly RelatedEdgeSource[] = ['sync', 'rethink', 'josh']

export function emptyForgeMeta(): ForgeMeta {
  return { views: new Map(), edges: new Map() }
}

function cloneView(v: ForgeView): ForgeView {
  return structuredClone(v)
}

export function applyMetaOp(m: ForgeMeta, op: ForgeMetaOp): void {
  switch (op.type) {
    case 'view.put':
      m.views.set(op.view.id, cloneView(op.view))
      return
    case 'view.delete':
      m.views.delete(op.id)
      return
    case 'edge.put':
      m.edges.set(op.edge.id, { ...op.edge })
      return
    case 'edge.delete':
      m.edges.delete(op.id)
      return
  }
}

function reviveView(raw: any): ForgeView | undefined {
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return undefined
  const view: ForgeView = {
    id: raw.id,
    membrane: String(raw.membrane ?? ''),
    title: raw.title,
    repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [],
    filters: raw.filters && typeof raw.filters === 'object' ? raw.filters : {}
  }
  if (typeof raw.height === 'number' && Number.isFinite(raw.height)) view.height = raw.height
  return view
}

function reviveEdge(raw: any): RelatedEdge | undefined {
  if (!raw || typeof raw.id !== 'string' || typeof raw.from !== 'string' || typeof raw.to !== 'string') return undefined
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    reason: String(raw.reason ?? ''),
    confidence: clampConfidence(Number(raw.confidence ?? 0)),
    source: EDGE_SOURCES.includes(raw.source) ? raw.source : 'rethink',
    membrane: raw.membrane ?? null,
    createdAt: String(raw.createdAt ?? new Date(0).toISOString())
  }
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

export function reviveMetaOp(raw: unknown): ForgeMetaOp | undefined {
  const op = raw as ForgeMetaOp
  if (!op || typeof op !== 'object') return undefined
  switch (op.type) {
    case 'view.put': {
      const view = reviveView(op.view)
      return view ? { type: 'view.put', view } : undefined
    }
    case 'edge.put': {
      const edge = reviveEdge(op.edge)
      return edge ? { type: 'edge.put', edge } : undefined
    }
    case 'view.delete':
    case 'edge.delete':
      return typeof op.id === 'string' ? { type: op.type, id: op.id } : undefined
    default:
      return undefined
  }
}

// ── AD4M mapping ──────────────────────────────────────────────────────

export function metaOpMutations(op: ForgeMetaOp): { add: LinkTriple[]; removeMatching: LinkPattern[] } {
  switch (op.type) {
    case 'view.put': {
      const v = op.view
      const add: LinkTriple[] = [
        { source: v.id, predicate: RDF_TYPE, target: T.ForgeView },
        { source: v.id, predicate: P.membrane, target: toLiteral(v.membrane) },
        { source: v.id, predicate: P.title, target: toLiteral(v.title) },
        { source: v.id, predicate: P.filters, target: toLiteral(JSON.stringify(v.filters ?? {})) },
        ...[...new Set(v.repos)].map((r) => ({ source: v.id, predicate: P.repo, target: toLiteral(r) }))
      ]
      if (v.height !== undefined) add.push({ source: v.id, predicate: P.height, target: toLiteral(String(v.height)) })
      return { add, removeMatching: [{ source: v.id }] }
    }
    case 'edge.put': {
      const e = op.edge
      const add: LinkTriple[] = [
        { source: e.id, predicate: RDF_TYPE, target: T.RelatedEdge },
        { source: e.id, predicate: P.from, target: toLiteral(e.from) },
        { source: e.id, predicate: P.to, target: toLiteral(e.to) },
        { source: e.id, predicate: P.reason, target: toLiteral(e.reason) },
        { source: e.id, predicate: P.confidence, target: toLiteral(String(e.confidence)) },
        { source: e.id, predicate: P.source, target: toLiteral(e.source) },
        { source: e.id, predicate: P.createdAt, target: toLiteral(e.createdAt) }
      ]
      if (e.membrane) add.push({ source: e.id, predicate: P.membrane, target: toLiteral(e.membrane) })
      return { add, removeMatching: [{ source: e.id }] }
    }
    case 'view.delete':
    case 'edge.delete':
      return { add: [], removeMatching: [{ source: op.id }] }
  }
}

export function forgeMetaFromLinks(links: LinkTriple[]): ForgeMeta {
  const m = emptyForgeMeta()
  const views = new Map<string, Record<string, any>>()
  const edges = new Map<string, Record<string, any>>()
  for (const l of links) {
    if (l.predicate !== RDF_TYPE) continue
    if (l.target === T.ForgeView) views.set(l.source, { id: l.source, repos: [] })
    else if (l.target === T.RelatedEdge) edges.set(l.source, { id: l.source })
  }
  for (const l of links) {
    const v = views.get(l.source)
    if (v) {
      const value = fromLiteral(l.target)
      if (l.predicate === P.membrane) v.membrane = value
      else if (l.predicate === P.title) v.title = value
      else if (l.predicate === P.repo) v.repos.push(value)
      else if (l.predicate === P.height) v.height = Number(value)
      else if (l.predicate === P.filters) {
        try {
          v.filters = JSON.parse(value)
        } catch {
          v.filters = {}
        }
      }
      continue
    }
    const e = edges.get(l.source)
    if (e) {
      const value = fromLiteral(l.target)
      if (l.predicate === P.from) e.from = value
      else if (l.predicate === P.to) e.to = value
      else if (l.predicate === P.reason) e.reason = value
      else if (l.predicate === P.confidence) e.confidence = Number(value)
      else if (l.predicate === P.source) e.source = value
      else if (l.predicate === P.membrane) e.membrane = value
      else if (l.predicate === P.createdAt) e.createdAt = value
    }
  }
  for (const raw of views.values()) {
    const v = reviveView(raw)
    if (v) m.views.set(v.id, v)
  }
  for (const raw of edges.values()) {
    const e = reviveEdge(raw)
    if (e) m.edges.set(e.id, e)
  }
  return m
}

function createAd4mMetaBackend(graph: LinkGraph): DurableBackend<ForgeMeta, ForgeMetaOp> {
  return {
    id: graph.id,
    load: async () => forgeMetaFromLinks(await graph.all()),
    apply: (op) => graph.mutate(metaOpMutations(op)),
    ping: () => graph.ping()
  }
}

// ── Store ─────────────────────────────────────────────────────────────

export interface SaveViewInput {
  id?: string
  membrane: string
  title: string
  repos?: string[]
  filters?: ForgeFilters
  height?: number
}

export interface AddEdgeInput {
  from: string
  to: string
  reason: string
  confidence?: number
  source: RelatedEdgeSource
  membrane?: string | null
}

export interface ForgeMetaStore {
  listViews(membrane?: string): ForgeView[]
  getView(id: string): ForgeView | null
  /** Create (no id) or replace (existing id) a view. */
  saveView(input: SaveViewInput): ForgeView
  deleteView(id: string): boolean
  listEdges(filter?: { membrane?: string; node?: string; source?: RelatedEdgeSource }): RelatedEdge[]
  /** Add an edge; an edge between the same two nodes (either direction) is updated instead. */
  addEdge(input: AddEdgeInput): RelatedEdge
  deleteEdge(id: string): boolean
  status(): DurableStatus
  settled(): Promise<void>
  sync(): Promise<void>
  dispose(): void
}

export interface ForgeMetaStoreOptions {
  dir: string
  connect: (() => Promise<LinkGraph>) | null
  onReconnect?: (cb: () => void) => () => void
  retryMs?: number
  callTimeoutMs?: number
  snapshotDelayMs?: number
  log?: Pick<Console, 'log' | 'warn' | 'error'>
}

export const META_OUTBOX_FILE = 'meta-outbox.jsonl'
export const META_SNAPSHOT_FILE = 'meta-snapshot.json'

export function createForgeMetaStore(opts: ForgeMetaStoreOptions): ForgeMetaStore {
  const connect = opts.connect
  const durable = createDurable<ForgeMeta, ForgeMetaOp>({
    name: 'forge-meta',
    dir: opts.dir,
    outboxFile: META_OUTBOX_FILE,
    snapshotFile: META_SNAPSHOT_FILE,
    connect: connect ? async () => createAd4mMetaBackend(await connect()) : null,
    onReconnect: opts.onReconnect,
    empty: emptyForgeMeta,
    apply: applyMetaOp,
    serialize: (m) => ({ views: [...m.views.values()], edges: [...m.edges.values()] }),
    deserialize: (raw: any) => {
      const m = emptyForgeMeta()
      for (const v of raw?.views ?? []) {
        const view = reviveView(v)
        if (view) m.views.set(view.id, view)
      }
      for (const e of raw?.edges ?? []) {
        const edge = reviveEdge(e)
        if (edge) m.edges.set(edge.id, edge)
      }
      return m
    },
    reviveOp: reviveMetaOp,
    seedOps: (m) => [
      ...[...m.views.values()].map((view): ForgeMetaOp => ({ type: 'view.put', view })),
      ...[...m.edges.values()].map((edge): ForgeMetaOp => ({ type: 'edge.put', edge }))
    ],
    isEmpty: (m) => m.views.size === 0 && m.edges.size === 0,
    retryMs: opts.retryMs,
    callTimeoutMs: opts.callTimeoutMs,
    snapshotDelayMs: opts.snapshotDelayMs,
    log: opts.log
  })
  const state = durable.state

  return {
    listViews(membrane) {
      return [...state().views.values()].filter((v) => membrane === undefined || v.membrane === membrane).map(cloneView)
    },
    getView(id) {
      const v = state().views.get(id)
      return v ? cloneView(v) : null
    },
    saveView(input) {
      if (!input.title?.trim()) throw new Error('A view needs a title')
      if (!input.membrane?.trim()) throw new Error('A view needs a membrane')
      const view: ForgeView = {
        id: input.id ?? `forge-view://${randomUUID()}`,
        membrane: input.membrane,
        title: input.title.trim(),
        repos: [...new Set(input.repos ?? [])],
        filters: input.filters ?? {}
      }
      if (input.height !== undefined) view.height = input.height
      durable.write({ type: 'view.put', view })
      return cloneView(view)
    },
    deleteView(id) {
      if (!state().views.has(id)) return false
      durable.write({ type: 'view.delete', id })
      return true
    },
    listEdges(filter = {}) {
      return [...state().edges.values()]
        .filter((e) => filter.membrane === undefined || e.membrane === filter.membrane)
        .filter((e) => filter.node === undefined || e.from === filter.node || e.to === filter.node)
        .filter((e) => filter.source === undefined || e.source === filter.source)
        .map((e) => ({ ...e }))
    },
    addEdge(input) {
      if (!input.from || !input.to) throw new Error('An edge needs from and to')
      if (input.from === input.to) throw new Error('An edge cannot join a node to itself')
      if (!EDGE_SOURCES.includes(input.source)) throw new Error(`Unknown edge source: ${input.source}`)
      const existing = [...state().edges.values()].find(
        (e) => (e.from === input.from && e.to === input.to) || (e.from === input.to && e.to === input.from)
      )
      const edge: RelatedEdge = {
        id: existing?.id ?? `forge-edge://${randomUUID()}`,
        from: existing?.from ?? input.from,
        to: existing?.to ?? input.to,
        reason: input.reason,
        confidence: clampConfidence(input.confidence ?? 0.5),
        source: input.source,
        membrane: input.membrane ?? existing?.membrane ?? null,
        createdAt: existing?.createdAt ?? new Date().toISOString()
      }
      durable.write({ type: 'edge.put', edge })
      return { ...edge }
    },
    deleteEdge(id) {
      if (!state().edges.has(id)) return false
      durable.write({ type: 'edge.delete', id })
      return true
    },
    status: durable.status,
    settled: durable.settled,
    sync: durable.sync,
    dispose: durable.dispose
  }
}
