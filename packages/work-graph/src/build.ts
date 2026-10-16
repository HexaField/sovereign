// Graph builder — pure. Nodes and edges from the repo caches, the plans and
// the task graph; windowing, view filters and search over the result.

import {
  refKey,
  type ForgeFilters,
  type ForgeRef,
  type ForgeView,
  type WorkEdge,
  type WorkNode,
  type WorkNodeState,
  type Zone
} from '@sovereign/core'
import type { Plan } from './plans.js'
import type { CachedChange, CachedIssue, PortTask, RelatedEdgeRecord, RepoCache } from './types.js'

export interface BuildInput {
  repos: RepoCache[]
  plans: Plan[]
  tasks: PortTask[]
  related: RelatedEdgeRecord[]
}

export interface BuiltGraph {
  nodes: WorkNode[]
  edges: WorkEdge[]
}

const PAIRED_HEAD_RE = /^\s*>\s*(?:#{1,6}\s*)?\**\s*paired with\b:?/i
const REF_RE =
  /https?:\/\/([a-z0-9.-]+)\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)|(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)\b/gi

/**
 * Refs in a PR body's "> ### Paired with: owner/repo#N" block: the heading
 * line and the quoted lines that follow it.
 */
export function parsePaired(body: string, host = 'github.com'): ForgeRef[] {
  const out = new Map<string, ForgeRef>()
  const lines = (body ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (!PAIRED_HEAD_RE.test(lines[i])) continue
    for (let j = i; j < lines.length && (j === i || /^\s*>/.test(lines[j])); j++) {
      for (const m of lines[j].matchAll(REF_RE)) {
        const r: ForgeRef = m[1]
          ? { forge: 'github', host: m[1].toLowerCase(), repo: `${m[2]}/${m[3]}`, kind: 'change', id: m[4] }
          : { forge: 'github', host, repo: `${m[5]}/${m[6]}`, kind: 'change', id: m[7] }
        out.set(refKey(r), r)
      }
    }
  }
  return [...out.values()]
}

export function branchNodeId(forge: string, host: string, repo: string, branch: string): string {
  return refKey({ forge: forge as ForgeRef['forge'], host, repo, kind: 'branch', id: branch })
}

/** Plan / task key → node id for a plan ref. */
export function planRefKey(host: string, repo: string, n: number): string {
  return refKey({ forge: 'github', host, repo, kind: 'issue', id: String(n) })
}

function changeZone(state: CachedChange['state']): Zone {
  return state === 'merged' || state === 'closed' ? 'past' : 'present'
}

function taskNodeState(s: PortTask['state']): WorkNodeState {
  return s === 'completed' ? 'done' : s === 'cancelled' ? 'cancelled' : s === 'in_progress' ? 'in_progress' : 'planned'
}

export function buildGraph(input: BuildInput): BuiltGraph {
  const nodes = new Map<string, WorkNode>()
  const edges = new Map<string, WorkEdge>()
  const addEdge = (e: WorkEdge) => {
    const k = `${e.from}\u0000${e.to}\u0000${e.kind}`
    if (!edges.has(k)) edges.set(k, e)
  }

  // Tasks by provider key; streams by id.
  const byKey = new Map<string, PortTask>()
  const taskById = new Map<string, PortTask>()
  for (const t of input.tasks) {
    taskById.set(t.id, t)
    if (t.key) byKey.set(t.key, t)
  }
  const streamsOf = (t?: PortTask) => (t ? t.parentIds.filter((p) => taskById.get(p)?.isStream) : [])
  const withTask = (n: WorkNode): WorkNode => {
    const t = byKey.get(n.id)
    if (!t) return n
    return {
      ...n,
      taskId: t.id,
      workstreams: streamsOf(t),
      ...(t.transientState ? { status: t.transientState } : {})
    }
  }

  // ── Forge items ────────────────────────────────────────────────────
  for (const rc of input.repos) {
    for (const c of Object.values(rc.changes)) {
      const id = refKey(c.ref)
      nodes.set(
        id,
        withTask({
          id,
          forge: c.ref.forge,
          kind: 'change',
          repo: c.ref.repo,
          number: Number(c.ref.id),
          title: c.title,
          url: c.url,
          state: c.state,
          zone: changeZone(c.state),
          author: c.author,
          assignees: c.assignees,
          reviewers: c.reviewers,
          labels: c.labels,
          workstreams: [],
          branch: {
            head: c.head.branch ?? '',
            base: c.base.branch,
            ...(c.compare ? { ahead: c.compare.ahead, behind: c.compare.behind } : {}),
            ...(c.mergeable === false ? { conflict: true } : {})
          },
          ci: c.checks?.state ?? 'none',
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          ...(c.closedAt ? { closedAt: c.closedAt } : {})
        })
      )
    }
    for (const i of Object.values(rc.issues)) {
      const id = refKey(i.ref)
      nodes.set(
        id,
        withTask({
          id,
          forge: i.ref.forge,
          kind: 'issue',
          repo: i.ref.repo,
          number: Number(i.ref.id),
          title: i.title,
          url: i.url,
          state: i.state,
          zone: i.state === 'open' ? 'future' : 'past',
          author: i.author,
          assignees: i.assignees,
          reviewers: [],
          labels: i.labels,
          workstreams: [],
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
          ...(i.closedAt ? { closedAt: i.closedAt } : {})
        })
      )
    }
  }

  // ── Branch relations (stacks) ──────────────────────────────────────
  for (const rc of input.repos) {
    const changes = Object.values(rc.changes)
    // head branch → changes with that head (same repo, not from a fork)
    const byHead = new Map<string, CachedChange[]>()
    for (const c of changes) {
      if (!c.head.branch || c.extra?.headRepo) continue
      const list = byHead.get(c.head.branch) ?? []
      list.push(c)
      byHead.set(c.head.branch, list)
    }
    // An integration branch (dev, staging) was a base before any change came
    // from it; a stack's branch only becomes a base after its own change opened.
    // Changes into an integration branch join the branch, not its release change.
    const firstAsBase = new Map<string, number>()
    for (const c of changes) {
      if (!c.base.branch) continue
      const t = Date.parse(c.createdAt)
      if (t < (firstAsBase.get(c.base.branch) ?? Infinity)) firstAsBase.set(c.base.branch, t)
    }
    const integration = (branch: string): boolean =>
      (firstAsBase.get(branch) ?? Infinity) <
      Math.min(...(byHead.get(branch) ?? []).map((c) => Date.parse(c.createdAt)))
    const rank = (c: CachedChange) => (c.state === 'open' || c.state === 'draft' ? 2 : c.state === 'merged' ? 1 : 0)
    const headChange = (branch: string, self: CachedChange): CachedChange | undefined =>
      integration(branch)
        ? undefined
        : (byHead.get(branch) ?? [])
            .filter((c) => c !== self)
            .sort((a, b) => rank(b) - rank(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]

    const branchTouch = new Map<string, { updatedAt: string; closedAt?: string }>()
    const target = (c: CachedChange): string => {
      const other = headChange(c.base.branch, c)
      if (other) return refKey(other.ref)
      const bid = branchNodeId(rc.forge, rc.host, rc.repo, c.base.branch)
      const prev = branchTouch.get(bid)
      const closedAt = [prev?.closedAt, c.closedAt]
        .filter((x): x is string => Boolean(x))
        .sort()
        .pop()
      branchTouch.set(bid, {
        updatedAt: !prev || c.updatedAt > prev.updatedAt ? c.updatedAt : prev.updatedAt,
        ...(closedAt ? { closedAt } : {})
      })
      return bid
    }
    for (const c of changes) {
      if (!c.base.branch) continue
      const from = refKey(c.ref)
      if (c.state === 'open' || c.state === 'draft') {
        addEdge({ from, to: target(c), kind: 'base', dashed: false, source: 'sync' })
      } else if (c.state === 'merged') {
        addEdge({ from, to: target(c), kind: 'merged-into', dashed: false, source: 'sync' })
      }
    }
    const listed = Object.keys(rc.branches).length > 0
    for (const [bid, t] of branchTouch) {
      const name = bid.slice(bid.indexOf('@') + 1)
      // A base branch is live unless the last branch list lacks it.
      const live = !listed || name in rc.branches
      nodes.set(bid, {
        id: bid,
        forge: rc.forge,
        kind: 'branch',
        repo: rc.repo,
        title: name,
        state: live ? 'open' : 'closed',
        zone: live ? 'present' : 'past',
        assignees: [],
        reviewers: [],
        labels: [],
        workstreams: [],
        branch: { head: name, base: name },
        createdAt: t.updatedAt,
        updatedAt: t.updatedAt,
        ...(!live && t.closedAt ? { closedAt: t.closedAt } : {})
      })
    }

    // ── closes, references, paired ────────────────────────────────────
    for (const c of changes) {
      const from = refKey(c.ref)
      for (const r of c.closes) {
        const to = refKey(r)
        addEdge({ from, to, kind: 'closes', dashed: nodes.get(to)?.state === 'open', source: 'sync' })
      }
      for (const r of c.references) addRef(refKey(r), from)
      for (const r of c.paired) {
        const to = refKey(r)
        const [a, b] = from < to ? [from, to] : [to, from]
        addEdge({ from: a, to: b, kind: 'paired', dashed: false, source: 'sync' })
      }
    }
    for (const i of Object.values(rc.issues) as CachedIssue[]) {
      for (const r of i.references) addRef(refKey(r), refKey(i.ref))
    }
  }

  /** `source` mentions `target` (a timeline cross-reference); a closes edge already says more. */
  function addRef(source: string, target: string) {
    if (edges.has(`${source}\u0000${target}\u0000closes`)) return
    addEdge({ from: source, to: target, kind: 'references', dashed: true, source: 'sync' })
  }
  // A closes edge found after a references edge between the same pair wins.
  for (const [k, e] of edges) {
    if (e.kind === 'references' && edges.has(`${e.from}\u0000${e.to}\u0000closes`)) edges.delete(k)
  }

  // ── Plans ──────────────────────────────────────────────────────────
  for (const p of input.plans) {
    nodes.set(
      p.id,
      withTask({
        id: p.id,
        forge: 'local',
        kind: 'plan',
        title: p.title,
        state: p.status === 'done' ? 'done' : p.status === 'in_progress' ? 'in_progress' : 'planned',
        zone: p.status === 'done' ? 'past' : 'future',
        assignees: [],
        reviewers: [],
        labels: [],
        workstreams: [],
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        ...(p.status === 'done' ? { closedAt: p.updatedAt } : {})
      })
    )
    for (const r of p.refs) {
      addEdge({ from: p.id, to: planRefKey(r.host, r.repo, r.number), kind: 'plans', dashed: true, source: 'sync' })
    }
  }

  // ── Task-only nodes and subtask edges ──────────────────────────────
  const nodeOfTask = new Map<string, string>()
  for (const t of input.tasks) {
    if (t.isStream) continue
    if (t.key) {
      if (nodes.has(t.key)) nodeOfTask.set(t.id, t.key)
      continue
    }
    const id = `task:${t.id}`
    const state = taskNodeState(t.state)
    nodes.set(id, {
      id,
      forge: 'local',
      kind: 'task',
      title: t.name,
      state,
      zone: state === 'done' || state === 'cancelled' ? 'past' : 'future',
      assignees: [],
      reviewers: [],
      labels: [],
      workstreams: streamsOf(t),
      taskId: t.id,
      ...(t.transientState ? { status: t.transientState } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...(state === 'done' || state === 'cancelled' ? { closedAt: t.updatedAt } : {})
    })
    nodeOfTask.set(t.id, id)
  }
  for (const t of input.tasks) {
    const from = nodeOfTask.get(t.id)
    if (!from) continue
    for (const c of t.childIds) {
      const to = nodeOfTask.get(c)
      if (to) addEdge({ from, to, kind: 'subtask', dashed: false, source: 'sync' })
    }
  }

  // ── Related (Loop 2, or the user) ──────────────────────────────────
  for (const r of input.related) {
    addEdge({
      from: r.from,
      to: r.to,
      kind: r.kind,
      dashed: true,
      source: r.accepted ? 'user' : r.source,
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.confidence !== undefined ? { confidence: r.confidence } : {})
    })
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()].filter((e) => nodes.has(e.from) && nodes.has(e.to))
  }
}

// ── Window, view filters, search ─────────────────────────────────────

/** The time a past node sits at: when it ended. */
export const endedAt = (n: WorkNode) => n.closedAt ?? n.updatedAt

/**
 * The served window: every past node that ended in [since, until), plus the
 * present and future when the window reaches now (a pan into older history
 * asks only for the past). A window that reaches now has no upper bound, so
 * an item the forge stamped a little ahead of this clock still shows.
 */
export function windowGraph(g: BuiltGraph, since: string, until: string, now = Date.now()): BuiltGraph {
  const s = Date.parse(since)
  const reachesNow = Date.parse(until) >= now - 60_000
  const u = reachesNow ? Infinity : Date.parse(until)
  const nodes = g.nodes.filter((n) => {
    if (n.zone !== 'past') return reachesNow
    const t = Date.parse(endedAt(n))
    return t >= s && t < u
  })
  return { nodes, edges: edgesAmong(g.edges, nodes) }
}

export function edgesAmong(edges: WorkEdge[], nodes: WorkNode[]): WorkEdge[] {
  const ids = new Set(nodes.map((n) => n.id))
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to))
}

const lower = (xs: string[] | undefined) => (xs?.length ? new Set(xs.map((x) => x.toLowerCase())) : undefined)

/** Does the node pass the filters? (agent filters need the overlay and are left to the client.) */
export function matchesFilters(n: WorkNode, f: ForgeFilters, ctx: { me?: string; now?: number } = {}): boolean {
  const repos = lower(f.repos)
  if (repos && !(n.repo && repos.has(n.repo.toLowerCase()))) return false
  if (f.states?.length && !f.states.includes(n.state)) return false
  if (f.zones?.length && !f.zones.includes(n.zone)) return false
  const authors = lower(f.authors)
  if (authors && !(n.author && authors.has(n.author.toLowerCase()))) return false
  const assignees = lower(f.assignees)
  if (assignees && !n.assignees.some((a) => assignees.has(a.toLowerCase()))) return false
  const reviewers = lower(f.reviewers)
  if (reviewers && !n.reviewers.some((r) => reviewers.has(r.login.toLowerCase()))) return false
  if (f.requestedFromMe) {
    const me = ctx.me?.toLowerCase()
    if (!me || !n.reviewers.some((r) => r.state === 'requested' && r.login.toLowerCase() === me)) return false
  }
  const labels = lower(f.labels)
  if (labels && !n.labels.some((l) => labels.has(l.toLowerCase()))) return false
  if (f.workstreams?.length && !n.workstreams.some((w) => f.workstreams!.includes(w))) return false
  if (f.updatedWithinDays !== undefined) {
    const cut = (ctx.now ?? Date.now()) - f.updatedWithinDays * 86_400_000
    if (Date.parse(n.updatedAt) < cut) return false
  }
  if (f.text && !matchesQuery(n, f.text)) return false
  return true
}

/** A view's base filter: its repos, then its filters. `dim` keeps every node (the client dims). */
export function applyView(
  g: BuiltGraph,
  view: ForgeView | undefined,
  ctx: { me?: string; now?: number } = {}
): BuiltGraph {
  if (!view) return g
  const filters: ForgeFilters = { ...view.filters }
  if (view.repos.length)
    filters.repos = filters.repos?.length ? filters.repos.filter((r) => view.repos.includes(r)) : view.repos
  const keep = (n: WorkNode) => {
    // Plans and task-only nodes have no repo: a repo filter does not hide them.
    if (!n.repo && filters.repos) return matchesFilters(n, { ...filters, repos: undefined }, ctx)
    return matchesFilters(n, filters, ctx)
  }
  if (filters.dim) return g
  const nodes = g.nodes.filter(keep)
  return { nodes, edges: edgesAmong(g.edges, nodes) }
}

/** Every whitespace-separated term matches title, number, branch, author, label or repo. */
export function matchesQuery(n: WorkNode, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return false
  const hay = [
    n.title,
    n.repo ?? '',
    n.number !== undefined ? `#${n.number} ${n.number}` : '',
    n.branch?.head ?? '',
    n.author ?? '',
    ...n.labels,
    ...n.assignees
  ]
    .join('\n')
    .toLowerCase()
  return terms.every((t) => hay.includes(t))
}

/** Search the full history: matching nodes (newest first, capped) and every edge touching one. */
export function searchGraph(g: BuiltGraph, q: string, limit = 200): BuiltGraph {
  const nodes = g.nodes
    .filter((n) => matchesQuery(n, q))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit)
  const ids = new Set(nodes.map((n) => n.id))
  return { nodes, edges: g.edges.filter((e) => ids.has(e.from) || ids.has(e.to)) }
}
