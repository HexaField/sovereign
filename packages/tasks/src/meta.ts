// Forge meta store — saved Forge views, the `related` edges agents add
// between work-graph nodes, and node categories set by rethink or the user.
// Same resilience as the task store (durable.ts): memory for reads, AD4M for
// writes, outbox while AD4M is down, snapshot for restarts. Files:
// <dir>/meta-outbox.jsonl, <dir>/meta-snapshot.json.

import { randomUUID } from 'node:crypto'
import {
  WORK_CATEGORIES,
  type ForgeFilters,
  type ForgeView,
  type WorkCategory,
  type WorkEdgeKind,
  type WorkEdgeSource
} from '@sovereign/core'
import type { DurableBackend, DurableStatus } from './durable.js'
import { createDurable } from './durable.js'
import type { LinkGraph, LinkPattern, LinkTriple } from './link-graph.js'
import { fromLiteral, toLiteral } from './link-graph.js'
import { P, RDF_TYPE, T } from './ontology.js'

export type RelatedEdgeSource = WorkEdgeSource

/** A suggested edge between two work-graph nodes (WorkNode ids), `related` unless it says otherwise. */
export interface RelatedEdge {
  id: string
  from: string
  to: string
  kind: WorkEdgeKind
  reason: string
  /** 0..1 */
  confidence: number
  source: RelatedEdgeSource
  /** The user accepted it (the graph shows it as source 'user'). */
  accepted: boolean
  membrane: string | null
  createdAt: string
}

/** A view as stored: its place in the membrane's list beside the view itself. */
export type StoredView = ForgeView & { position?: number }

/** One source's category of a node: `forge-category://<membrane>/<source>/<node id>` (parts URI-encoded). */
export interface StoredCategory {
  id: string
  membrane: string
  nodeId: string
  category: WorkCategory
  source: CategorySource
  reason: string
  createdAt: string
}

export type CategorySource = 'rethink' | 'user'

export interface ForgeMeta {
  views: Map<string, StoredView>
  edges: Map<string, RelatedEdge>
  categories: Map<string, StoredCategory>
}

export type ForgeMetaOp =
  | { type: 'view.put'; view: StoredView }
  | { type: 'view.delete'; id: string }
  | { type: 'edge.put'; edge: RelatedEdge }
  | { type: 'edge.delete'; id: string }
  | { type: 'category.put'; category: StoredCategory }
  | { type: 'category.delete'; id: string }

const EDGE_SOURCES: readonly RelatedEdgeSource[] = ['sync', 'rethink', 'user']
const CATEGORY_SOURCES: readonly CategorySource[] = ['rethink', 'user']
const CATEGORY_PREFIX = 'forge-category://'

export function categoryId(membrane: string, source: CategorySource, nodeId: string): string {
  return `${CATEGORY_PREFIX}${encodeURIComponent(membrane)}/${source}/${encodeURIComponent(nodeId)}`
}

const EDGE_KINDS: readonly WorkEdgeKind[] = [
  'base',
  'merged-into',
  'closes',
  'references',
  'paired',
  'plans',
  'subtask',
  'related',
  'depends-on'
]

export function emptyForgeMeta(): ForgeMeta {
  return { views: new Map(), edges: new Map(), categories: new Map() }
}

function cloneView<V extends ForgeView>(v: V): V {
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
    case 'category.put':
      m.categories.set(op.category.id, { ...op.category })
      return
    case 'category.delete':
      m.categories.delete(op.id)
      return
  }
}

function reviveView(raw: any): StoredView | undefined {
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string') return undefined
  const view: StoredView = {
    id: raw.id,
    membrane: String(raw.membrane ?? ''),
    title: raw.title,
    repos: Array.isArray(raw.repos) ? raw.repos.map(String) : [],
    filters: raw.filters && typeof raw.filters === 'object' ? raw.filters : {}
  }
  if (typeof raw.height === 'number' && Number.isFinite(raw.height)) view.height = raw.height
  if (typeof raw.position === 'number' && Number.isFinite(raw.position)) view.position = raw.position
  return view
}

function reviveEdge(raw: any): RelatedEdge | undefined {
  if (!raw || typeof raw.id !== 'string' || typeof raw.from !== 'string' || typeof raw.to !== 'string') return undefined
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    kind: EDGE_KINDS.includes(raw.kind) ? raw.kind : 'related',
    reason: String(raw.reason ?? ''),
    confidence: clampConfidence(Number(raw.confidence ?? 0)),
    source: EDGE_SOURCES.includes(raw.source) ? raw.source : 'rethink',
    accepted: raw.accepted === true || raw.accepted === 'true',
    membrane: raw.membrane ?? null,
    createdAt: String(raw.createdAt ?? new Date(0).toISOString())
  }
}

function reviveCategory(raw: any): StoredCategory | undefined {
  if (!raw || typeof raw.id !== 'string' || typeof raw.nodeId !== 'string' || typeof raw.membrane !== 'string')
    return undefined
  if (!WORK_CATEGORIES.includes(raw.category) || !CATEGORY_SOURCES.includes(raw.source)) return undefined
  return {
    id: raw.id,
    membrane: raw.membrane,
    nodeId: raw.nodeId,
    category: raw.category,
    source: raw.source,
    reason: String(raw.reason ?? ''),
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
    case 'category.put': {
      const category = reviveCategory(op.category)
      return category ? { type: 'category.put', category } : undefined
    }
    case 'view.delete':
    case 'edge.delete':
    case 'category.delete':
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
      if (v.position !== undefined)
        add.push({ source: v.id, predicate: P.position, target: toLiteral(String(v.position)) })
      return { add, removeMatching: [{ source: v.id }] }
    }
    case 'edge.put': {
      const e = op.edge
      const add: LinkTriple[] = [
        { source: e.id, predicate: RDF_TYPE, target: T.RelatedEdge },
        { source: e.id, predicate: P.from, target: toLiteral(e.from) },
        { source: e.id, predicate: P.to, target: toLiteral(e.to) },
        { source: e.id, predicate: P.kind, target: toLiteral(e.kind) },
        { source: e.id, predicate: P.accepted, target: toLiteral(String(e.accepted)) },
        { source: e.id, predicate: P.reason, target: toLiteral(e.reason) },
        { source: e.id, predicate: P.confidence, target: toLiteral(String(e.confidence)) },
        { source: e.id, predicate: P.source, target: toLiteral(e.source) },
        { source: e.id, predicate: P.createdAt, target: toLiteral(e.createdAt) }
      ]
      if (e.membrane) add.push({ source: e.id, predicate: P.membrane, target: toLiteral(e.membrane) })
      return { add, removeMatching: [{ source: e.id }] }
    }
    case 'category.put': {
      const c = op.category
      const add: LinkTriple[] = [
        { source: c.id, predicate: RDF_TYPE, target: T.NodeCategory },
        { source: c.id, predicate: P.membrane, target: toLiteral(c.membrane) },
        { source: c.id, predicate: P.node, target: toLiteral(c.nodeId) },
        { source: c.id, predicate: P.category, target: toLiteral(c.category) },
        { source: c.id, predicate: P.source, target: toLiteral(c.source) },
        { source: c.id, predicate: P.reason, target: toLiteral(c.reason) },
        { source: c.id, predicate: P.createdAt, target: toLiteral(c.createdAt) }
      ]
      return { add, removeMatching: [{ source: c.id }] }
    }
    case 'view.delete':
    case 'edge.delete':
    case 'category.delete':
      return { add: [], removeMatching: [{ source: op.id }] }
  }
}

export function forgeMetaFromLinks(links: LinkTriple[]): ForgeMeta {
  const m = emptyForgeMeta()
  const views = new Map<string, Record<string, any>>()
  const edges = new Map<string, Record<string, any>>()
  const categories = new Map<string, Record<string, any>>()
  for (const l of links) {
    if (l.predicate !== RDF_TYPE) continue
    if (l.target === T.ForgeView) views.set(l.source, { id: l.source, repos: [] })
    else if (l.target === T.RelatedEdge) edges.set(l.source, { id: l.source })
    else if (l.target === T.NodeCategory) categories.set(l.source, { id: l.source })
  }
  for (const l of links) {
    const v = views.get(l.source)
    if (v) {
      const value = fromLiteral(l.target)
      if (l.predicate === P.membrane) v.membrane = value
      else if (l.predicate === P.title) v.title = value
      else if (l.predicate === P.repo) v.repos.push(value)
      else if (l.predicate === P.height) v.height = Number(value)
      else if (l.predicate === P.position) v.position = Number(value)
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
      else if (l.predicate === P.kind) e.kind = value
      else if (l.predicate === P.accepted) e.accepted = value
      else if (l.predicate === P.reason) e.reason = value
      else if (l.predicate === P.confidence) e.confidence = Number(value)
      else if (l.predicate === P.source) e.source = value
      else if (l.predicate === P.membrane) e.membrane = value
      else if (l.predicate === P.createdAt) e.createdAt = value
      continue
    }
    const c = categories.get(l.source)
    if (c) {
      const value = fromLiteral(l.target)
      if (l.predicate === P.membrane) c.membrane = value
      else if (l.predicate === P.node) c.nodeId = value
      else if (l.predicate === P.category) c.category = value
      else if (l.predicate === P.source) c.source = value
      else if (l.predicate === P.reason) c.reason = value
      else if (l.predicate === P.createdAt) c.createdAt = value
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
  for (const raw of categories.values()) {
    const c = reviveCategory(raw)
    if (c) m.categories.set(c.id, c)
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
  /** Place in the membrane's list. */
  position?: number
}

export interface AddEdgeInput {
  from: string
  to: string
  /** Default 'related'. */
  kind?: WorkEdgeKind
  reason: string
  confidence?: number
  source: RelatedEdgeSource
  membrane?: string | null
}

export interface ForgeMetaStore {
  /** Views by position, then in the order they were added. */
  listViews(membrane?: string): StoredView[]
  getView(id: string): StoredView | null
  /** Create (no id) or replace (existing id) a view. */
  saveView(input: SaveViewInput): StoredView
  deleteView(id: string): boolean
  listEdges(filter?: { membrane?: string; node?: string; source?: RelatedEdgeSource }): RelatedEdge[]
  /** Add an edge; an edge of the same kind between the same two nodes (either direction) is updated instead. */
  addEdge(input: AddEdgeInput): RelatedEdge
  /** Mark an edge accepted by the user; false when there is no such edge. */
  acceptEdge(id: string): boolean
  deleteEdge(id: string): boolean
  listCategories(membrane?: string): StoredCategory[]
  /** Set one source's category of a node (replacing that source's previous one); null clears it. */
  setCategory(input: {
    membrane: string
    nodeId: string
    source: CategorySource
    category: WorkCategory | null
    reason?: string
  }): StoredCategory | null
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
    serialize: (m) => ({
      views: [...m.views.values()],
      edges: [...m.edges.values()],
      categories: [...m.categories.values()]
    }),
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
      for (const c of raw?.categories ?? []) {
        const category = reviveCategory(c)
        if (category) m.categories.set(category.id, category)
      }
      return m
    },
    reviveOp: reviveMetaOp,
    seedOps: (m) => [
      ...[...m.views.values()].map((view): ForgeMetaOp => ({ type: 'view.put', view })),
      ...[...m.edges.values()].map((edge): ForgeMetaOp => ({ type: 'edge.put', edge })),
      ...[...m.categories.values()].map((category): ForgeMetaOp => ({ type: 'category.put', category }))
    ],
    isEmpty: (m) => m.views.size === 0 && m.edges.size === 0 && m.categories.size === 0,
    retryMs: opts.retryMs,
    callTimeoutMs: opts.callTimeoutMs,
    snapshotDelayMs: opts.snapshotDelayMs,
    log: opts.log
  })
  const state = durable.state

  return {
    listViews(membrane) {
      const at = (v: StoredView) => v.position ?? Number.POSITIVE_INFINITY
      return [...state().views.values()]
        .filter((v) => membrane === undefined || v.membrane === membrane)
        .sort((a, b) => (at(a) === at(b) ? 0 : at(a) - at(b)))
        .map(cloneView)
    },
    getView(id) {
      const v = state().views.get(id)
      return v ? cloneView(v) : null
    },
    saveView(input) {
      if (!input.title?.trim()) throw new Error('A view needs a title')
      if (!input.membrane?.trim()) throw new Error('A view needs a membrane')
      const view: StoredView = {
        id: input.id ?? `forge-view://${randomUUID()}`,
        membrane: input.membrane,
        title: input.title.trim(),
        repos: [...new Set(input.repos ?? [])],
        filters: input.filters ?? {}
      }
      if (input.height !== undefined) view.height = input.height
      if (input.position !== undefined) view.position = input.position
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
      const kind = input.kind ?? 'related'
      if (!EDGE_KINDS.includes(kind)) throw new Error(`Unknown edge kind: ${kind}`)
      const existing = [...state().edges.values()].find(
        (e) =>
          e.kind === kind &&
          ((e.from === input.from && e.to === input.to) || (e.from === input.to && e.to === input.from))
      )
      const edge: RelatedEdge = {
        id: existing?.id ?? `forge-edge://${randomUUID()}`,
        from: existing?.from ?? input.from,
        to: existing?.to ?? input.to,
        kind,
        reason: input.reason,
        confidence: clampConfidence(input.confidence ?? 0.5),
        source: input.source,
        accepted: existing?.accepted ?? false,
        membrane: input.membrane ?? existing?.membrane ?? null,
        createdAt: existing?.createdAt ?? new Date().toISOString()
      }
      durable.write({ type: 'edge.put', edge })
      return { ...edge }
    },
    acceptEdge(id) {
      const e = state().edges.get(id)
      if (!e) return false
      if (!e.accepted) durable.write({ type: 'edge.put', edge: { ...e, accepted: true } })
      return true
    },
    deleteEdge(id) {
      if (!state().edges.has(id)) return false
      durable.write({ type: 'edge.delete', id })
      return true
    },
    listCategories(membrane) {
      return [...state().categories.values()]
        .filter((c) => membrane === undefined || c.membrane === membrane)
        .map((c) => ({ ...c }))
    },
    setCategory(input) {
      if (!input.membrane || !input.nodeId) throw new Error('A category needs a membrane and a node')
      if (!CATEGORY_SOURCES.includes(input.source)) throw new Error(`Unknown category source: ${input.source}`)
      const id = categoryId(input.membrane, input.source, input.nodeId)
      if (input.category === null) {
        if (state().categories.has(id)) durable.write({ type: 'category.delete', id })
        return null
      }
      if (!WORK_CATEGORIES.includes(input.category)) throw new Error(`Unknown category: ${input.category}`)
      const category: StoredCategory = {
        id,
        membrane: input.membrane,
        nodeId: input.nodeId,
        category: input.category,
        source: input.source,
        reason: input.reason ?? '',
        createdAt: new Date().toISOString()
      }
      durable.write({ type: 'category.put', category })
      return { ...category }
    },
    status: durable.status,
    settled: durable.settled,
    sync: durable.sync,
    dispose: durable.dispose
  }
}
