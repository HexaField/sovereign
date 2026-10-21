import { describe, it, expect } from 'vitest'
import type { WorkNode } from '@sovereign/core'
import {
  COL_W,
  NODE_W,
  activityColumn,
  branchAliases,
  computeLayout,
  futureDepths,
  orderStreams,
  rectsOverlap,
  streamCardId,
  streamOfCard,
  streamTree,
  timeToX,
  type Layout
} from './layout.js'
import { NOW, change, edge, issue, iso, merged, plan, shuffled, stream, task } from './test-fixtures.js'

const CORE = 'demo-org/engine'
const APP = 'demo-org/app'

/** A made-up membrane: a 6-PR stack, a paired cross-repo pair, history, issues, a plan and task-only nodes. */
function sampleGraph() {
  const stack: WorkNode[] = []
  for (let i = 0; i < 6; i++) {
    stack.push(
      change(CORE, 100 + i, {
        title: `Stack part ${i + 1}`,
        workstreams: ['s-stack'],
        createdAt: iso(12 - i),
        updatedAt: iso(0.5 + i * 0.1),
        branch: { head: `stack/part-${i + 1}`, base: i === 0 ? 'dev' : `stack/part-${i}` }
      })
    )
  }
  const stackEdges = stack.slice(1).map((n, i) => edge(n, stack[i], 'base'))
  const coreOpen = change(CORE, 200, { createdAt: iso(4), updatedAt: iso(2) })
  const appOpen = change(APP, 59, { createdAt: iso(3), updatedAt: iso(0.2) })
  const history = [
    merged(CORE, 90, 1),
    merged(CORE, 91, 1.2),
    merged(CORE, 92, 6),
    merged(APP, 40, 9),
    change(CORE, 93, { state: 'closed', zone: 'past', closedAt: iso(15), createdAt: iso(30), updatedAt: iso(15) })
  ]
  const issues = [issue(CORE, 300, { createdAt: iso(40) }), issue(CORE, 301, { createdAt: iso(20) }), issue(APP, 7)]
  const p = plan('plans/stack.md', { workstreams: ['s-stack'] })
  const planEdges = [edge(p, issues[0], 'plans'), edge(issues[0], issues[1], 'references')]
  const t1 = task('decide-box', { workstreams: ['s-stack'], title: 'Decide the gate box' })
  const t2 = task('order-parts', { workstreams: ['s-stack'] })
  const nodes = [...stack, coreOpen, appOpen, ...history, ...issues, p, t1, t2]
  const edges = [
    ...stackEdges,
    edge(appOpen, coreOpen, 'paired'),
    edge(coreOpen, issues[1], 'closes', { dashed: true }),
    ...planEdges,
    edge(p, t1, 'subtask'),
    edge(t1, t2, 'subtask')
  ]
  const workstreams = [stream('s-stack', 'Stack rollout')]
  return { nodes, edges, workstreams, stack, coreOpen, appOpen, history, issues, plan: p, tasks: [t1, t2] }
}

function noOverlaps(layout: Layout): void {
  const byLane = new Map<string, { x: number; y: number; w: number; h: number; id: string }[]>()
  for (const p of layout.nodes.values()) {
    const list = byLane.get(p.lane) ?? []
    list.push(p)
    byLane.set(p.lane, list)
  }
  for (const b of layout.branches) {
    const list = byLane.get(b.lane) ?? []
    // A branch line is a 2-px strip in its row; it must not run under another node.
    list.push({ id: `line:${b.nodeId}`, x: b.x0, y: b.y - 1, w: b.x1 - b.x0, h: 2 })
    byLane.set(b.lane, list)
  }
  for (const [lane, list] of byLane) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (rectsOverlap(list[i], list[j])) throw new Error(`overlap in ${lane}: ${list[i].id} × ${list[j].id}`)
      }
  }
}

describe('computeLayout', () => {
  it('splits x into past < now (0) < present < future', () => {
    const g = sampleGraph()
    const l = computeLayout({ ...g, now: NOW })
    for (const n of g.history) expect(l.nodes.get(n.id)!.x + NODE_W).toBeLessThan(0)
    for (const n of [...g.stack, g.coreOpen, g.appOpen]) {
      const p = l.nodes.get(n.id)!
      expect(p.x).toBeGreaterThanOrEqual(l.presentStart)
      expect(p.x + p.w).toBeLessThan(l.futureStart)
    }
    for (const n of [...g.issues, g.plan, ...g.tasks])
      expect(l.nodes.get(n.id)!.x).toBeGreaterThanOrEqual(l.futureStart)
  })

  it('places past items by close date, newest nearest the divider', () => {
    const g = sampleGraph()
    const l = computeLayout({ ...g, now: NOW })
    const x = (n: WorkNode) => l.nodes.get(n.id)!.x
    const [m90, m91, m92, , closed93] = g.history
    expect(x(m90)).toBeGreaterThan(x(m91))
    expect(x(m91)).toBeGreaterThan(x(m92))
    expect(x(m92)).toBeGreaterThan(x(closed93))
    // Right edge sits on the close date (clamped off the divider for very recent closes).
    expect(x(m92) + NODE_W).toBeCloseTo(timeToX(Date.parse(m92.closedAt!), NOW))
  })

  it('chains a 6-PR stack left → right in one row along its base edges', () => {
    const g = sampleGraph()
    const l = computeLayout({ ...g, now: NOW })
    const placed = g.stack.map((n) => l.nodes.get(n.id)!)
    expect(new Set(placed.map((p) => p.row)).size).toBe(1)
    expect(new Set(placed.map((p) => p.lane))).toEqual(new Set(['stream:s-stack']))
    for (let i = 1; i < placed.length; i++) expect(placed[i].x - placed[i - 1].x).toBe(COL_W)
    // Only the stack's root forks off the past; the rest hang off their base.
    const lines = l.branches.filter((b) => g.stack.some((n) => n.id === b.nodeId))
    expect(lines.map((b) => b.nodeId)).toEqual([g.stack[0].id])
    expect(lines[0].x0).toBeCloseTo(timeToX(Date.parse(g.stack[0].createdAt), NOW))
    expect(lines[0].x1).toBe(placed[0].x)
  })

  it("keeps a stack in its root's lane, left → right, even when its PRs belong to other streams too", () => {
    const g = sampleGraph()
    // The root also sits in an earlier-ranked stream; the root was updated last.
    const other = { id: 'a-other', name: 'A other', membrane: 'm', memberCount: 1, status: 'active' as const }
    const stack = g.stack.map((n, i) =>
      i === 0
        ? { ...n, workstreams: ['a-other', ...n.workstreams], updatedAt: new Date(NOW - 60_000).toISOString() }
        : n
    )
    const nodes = g.nodes.map((n) => stack.find((s) => s.id === n.id) ?? n)
    const l = computeLayout({ ...g, nodes, workstreams: [other, ...g.workstreams], now: NOW })
    const placed = stack.map((n) => l.nodes.get(n.id)!)
    expect(new Set(placed.map((p) => p.lane))).toEqual(new Set(['stream:a-other']))
    for (let i = 1; i < placed.length; i++) expect(placed[i].x - placed[i - 1].x).toBe(COL_W)
  })

  it('an item of a stream the canvas does not draw falls to its repo lane', () => {
    const goal = stream('g', 'Goal')
    const a = issue(CORE, 1, { workstreams: ['d'] })
    const b = issue(CORE, 2, { workstreams: ['g'] })
    const l = computeLayout({ nodes: [a, b], edges: [], workstreams: [goal], now: NOW })
    expect(l.nodes.get(a.id)!.lane).toBe(`repo:${CORE}`)
    expect(l.nodes.get(b.id)!.lane).toBe('stream:g')
  })

  it('keeps a paired cross-repo edge between the two repo lanes', () => {
    const g = sampleGraph()
    const l = computeLayout({ ...g, now: NOW })
    const paired = l.edges.filter((e) => e.kind === 'paired')
    expect(paired).toEqual([expect.objectContaining({ from: g.appOpen.id, to: g.coreOpen.id })])
    expect(l.nodes.get(g.appOpen.id)!.lane).toBe(`repo:${APP}`)
    expect(l.nodes.get(g.coreOpen.id)!.lane).toBe(`repo:${CORE}`)
  })

  it('puts a related node in the epic lane only with Owned + related, marked related; the owner lane wins', () => {
    const g = sampleGraph()
    const other = { id: 'z-other', name: 'Z other', membrane: 'm', memberCount: 0, status: 'active' as const }
    const rel = { ...g.coreOpen, relatedStreams: ['s-stack'] }
    const ownedRel = { ...g.issues[0], workstreams: ['z-other'], relatedStreams: ['s-stack'] }
    const nodes = g.nodes.map((n) => (n.id === rel.id ? rel : n.id === ownedRel.id ? ownedRel : n))
    const input = { ...g, nodes, workstreams: [...g.workstreams, other], now: NOW }

    const owned = computeLayout(input)
    expect(owned.nodes.get(rel.id)).toMatchObject({ lane: `repo:${CORE}` })
    expect(owned.nodes.get(rel.id)).not.toHaveProperty('related')

    const withRelated = computeLayout({ ...input, related: true })
    expect(withRelated.nodes.get(rel.id)).toMatchObject({ lane: 'stream:s-stack', related: true })
    expect(withRelated.nodes.get(ownedRel.id)).toMatchObject({ lane: 'stream:z-other' })
    expect(withRelated.nodes.get(ownedRel.id)).not.toHaveProperty('related')
    // Owned stack members in the same lane carry no related mark.
    for (const n of g.stack) expect(withRelated.nodes.get(n.id)).not.toHaveProperty('related')
  })

  it('orders lanes: streams, then repos alphabetically, then Other', () => {
    const g = sampleGraph()
    const loose = task('loose')
    const l = computeLayout({ ...g, nodes: [...g.nodes, loose], now: NOW })
    expect(l.lanes.map((x) => x.id)).toEqual(['stream:s-stack', `repo:${APP}`, `repo:${CORE}`, 'other'])
    for (let i = 1; i < l.lanes.length; i++) expect(l.lanes[i].y).toBe(l.lanes[i - 1].y + l.lanes[i - 1].h)
    expect(l.nodes.get(loose.id)!.lane).toBe('other')
  })

  it('puts plans and task-only nodes in their stream lane, columns by dependency depth', () => {
    const g = sampleGraph()
    const l = computeLayout({ ...g, now: NOW })
    const p = l.nodes.get(g.plan.id)!
    const [t1, t2] = g.tasks.map((t) => l.nodes.get(t.id)!)
    expect(p.lane).toBe('stream:s-stack')
    expect(t1.lane).toBe('stream:s-stack')
    expect([p.depth, t1.depth, t2.depth]).toEqual([0, 1, 2])
    expect(p.x).toBeLessThan(t1.x)
    expect(t1.x).toBeLessThan(t2.x)
    // The plan's issue follows it even though it lives in another lane.
    const i300 = l.nodes.get(g.issues[0].id)!
    const i301 = l.nodes.get(g.issues[1].id)!
    expect(i300.depth).toBe(1)
    expect(i301.depth).toBe(2)
  })

  it('never overlaps two nodes, or a node and a branch line, within a lane', () => {
    const g = sampleGraph()
    noOverlaps(computeLayout({ ...g, now: NOW }))
    // Dense: 60 merges in one day and 40 open changes with old forks in one repo.
    const dense: WorkNode[] = []
    for (let i = 0; i < 60; i++) dense.push(merged(CORE, 1000 + i, 2 + (i % 3) * 0.01))
    for (let i = 0; i < 40; i++) dense.push(change(CORE, 2000 + i, { createdAt: iso(3 + i), updatedAt: iso(i % 5) }))
    for (let i = 0; i < 30; i++) dense.push(issue(CORE, 3000 + i, { createdAt: iso(i) }))
    const l = computeLayout({ nodes: dense, edges: [], workstreams: [], now: NOW, since: NOW - 21 * 86_400_000 })
    noOverlaps(l)
    expect(l.nodes.size).toBe(dense.length)
  })

  it('is deterministic: a shuffled input gives the identical layout', () => {
    const g = sampleGraph()
    const a = computeLayout({ ...g, now: NOW })
    const b = computeLayout({
      nodes: shuffled(g.nodes, 3),
      edges: shuffled(g.edges, 11),
      workstreams: g.workstreams,
      now: NOW
    })
    expect([...b.nodes.entries()].sort()).toEqual([...a.nodes.entries()].sort())
    expect(b.lanes).toEqual(a.lanes)
    expect(b.branches).toEqual(a.branches)
    expect(b.edges).toEqual(a.edges)
  })

  it('clips branch lines that fork before the loaded window', () => {
    const old = change(CORE, 5, { createdAt: iso(90), updatedAt: iso(1) })
    const since = NOW - 21 * 86_400_000
    const l = computeLayout({ nodes: [old], edges: [], workstreams: [], now: NOW, since })
    expect(l.branches).toEqual([expect.objectContaining({ nodeId: old.id, clipped: true, x0: timeToX(since, NOW) })])
  })

  it('draws a live branch as its change, and redirects edges to it', () => {
    const c = change(CORE, 8, { branch: { head: 'feat/x', base: 'dev' } })
    const br: WorkNode = {
      ...change(CORE, 0),
      id: 'github:github.com/demo-org/engine@feat/x',
      kind: 'branch',
      number: undefined,
      title: 'feat/x',
      branch: { head: 'feat/x', base: 'dev' }
    }
    const i = issue(CORE, 9)
    const l = computeLayout({ nodes: [c, br, i], edges: [edge(br, i, 'references')], workstreams: [], now: NOW })
    expect(l.nodes.has(br.id)).toBe(false)
    expect(l.alias.get(br.id)).toBe(c.id)
    expect(l.edges).toEqual([expect.objectContaining({ from: c.id, to: i.id, kind: 'references' })])
  })

  it('drops edges whose ends are not loaded, and duplicate edges', () => {
    const a = change(CORE, 1)
    const b = issue(CORE, 2)
    const l = computeLayout({
      nodes: [a, b],
      edges: [edge(a, b, 'closes'), edge(a, b, 'closes'), edge(a, 'github:github.com/x/y#1', 'references')],
      workstreams: [],
      now: NOW
    })
    expect(l.edges).toHaveLength(1)
  })

  it('wraps a tall future column into sub-columns', () => {
    const many = Array.from({ length: 13 }, (_, i) => issue(CORE, 500 + i, { createdAt: iso(30 - i) }))
    const l = computeLayout({ nodes: many, edges: [], workstreams: [], now: NOW })
    const xs = [...new Set(many.map((n) => l.nodes.get(n.id)!.x))].sort((a, b) => a - b)
    expect(xs).toHaveLength(3) // 6 + 6 + 1
    // Oldest first, down the first column.
    expect(l.nodes.get(many[0].id)!.row).toBe(0)
    expect(l.nodes.get(many[1].id)!.row).toBe(1)
    expect(l.nodes.get(many[6].id)!.x).toBe(xs[1])
    noOverlaps(l)
  })
})

/**
 * A goal tree: goal G (hand-made) → A (a plan's stream, plan node loaded) and
 * B (hand-made, owns a PR); A → C (hand-made, owns an issue); A owns an issue.
 * Plus an empty hand-made goal E and a loose plan.
 */
function treeGraph() {
  const planA = plan('plans/auth.md', { workstreams: ['g'] }) // a plan node sits in its stream's parent
  const loosePlan = plan('plans/loose.md')
  const g = stream('g', 'Closed beta', { status: 'active', progress: { done: 1, total: 4, blocked: 1 } })
  const a = stream('a', 'Auth', { parentId: 'g', plan: planA.id, status: 'active' })
  const b = stream('b', 'Delivery', { parentId: 'g' })
  const c = stream('c', 'Revocation', { parentId: 'a' })
  const e = stream('e', 'Someday')
  const inA = issue(CORE, 10, { workstreams: ['a'] })
  const inB = change(CORE, 11, { workstreams: ['b'] })
  const inC = issue(CORE, 12, { workstreams: ['c'] })
  const inC2 = task('logout', { workstreams: ['c'] })
  const loose = change(APP, 5)
  const nodes = [planA, loosePlan, inA, inB, inC, inC2, loose]
  const edges = [edge(planA, inA, 'plans')]
  return { nodes, edges, workstreams: [e, b, g, c, a], planA, loosePlan, g, a, b, c, e, inA, inB, inC, inC2, loose }
}

describe('goal tree on the canvas', () => {
  const cardOf = (l: Layout, streamId: string) =>
    [...l.nodes.values()].find((p) => p.stream === streamId) ?? expect.unreachable(`no card for ${streamId}`)

  it('puts every root on the far right, one column nearer now per level down', () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, now: NOW })
    const x = (id: string) => cardOf(l, id).x
    expect(x('g')).toBe(x('e')) // all goals line up
    expect(x('g') - x('a')).toBe(COL_W)
    expect(x('a')).toBe(x('b'))
    expect(x('a') - x('c')).toBe(COL_W)
    expect(cardOf(l, 'c').depth).toBe(2)
    // The deepest column sits right of every leaf on the timeline.
    for (const p of l.nodes.values()) if (!p.stream) expect(p.x + p.w).toBeLessThan(x('c'))
    expect(cardOf(l, 'g').zone).toBe('future')
  })

  it("uses a plan stream's plan node as its card; a hand-made stream gets a synthetic card", () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, now: NOW })
    expect(cardOf(l, 'a').id).toBe(t.planA.id)
    expect(l.nodes.has(streamCardId('a'))).toBe(false)
    expect(cardOf(l, 'b').id).toBe(streamCardId('b'))
    expect(streamOfCard(streamCardId('b'))).toBe('b')
    expect(streamOfCard(t.planA.id)).toBeNull()
    expect(l.tree.cards.get(streamCardId('b'))!.name).toBe('Delivery')
    expect(l.tree.cards.get(t.planA.id)!.id).toBe('a')
    // The loose plan keeps its place in the future zone, no card.
    const lp = l.nodes.get(t.loosePlan.id)!
    expect(lp.stream).toBeUndefined()
    expect(lp.x).toBeLessThan(cardOf(l, 'c').x)
    // The plan's own edges still reach its card.
    expect(l.edges).toContainEqual(expect.objectContaining({ from: t.planA.id, to: t.inA.id }))
  })

  it('falls back to a synthetic card when the plan node is not loaded', () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, nodes: t.nodes.filter((n) => n.id !== t.planA.id), now: NOW })
    expect(cardOf(l, 'a').id).toBe(streamCardId('a'))
  })

  it('links each child card to its parent card', () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, now: NOW })
    const sorted = (xs: { from: string; to: string }[]) => [...xs].sort((p, q) => p.from.localeCompare(q.from))
    expect(sorted(l.tree.links)).toEqual(
      sorted([
        { from: t.planA.id, to: streamCardId('g') },
        { from: streamCardId('b'), to: streamCardId('g') },
        { from: streamCardId('c'), to: t.planA.id }
      ])
    )
  })

  it('orders lanes depth-first; an inner stream with no items has no lane, an empty leaf stream a compact one', () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, now: NOW })
    // Siblings keep the server's order (B before A); a subtree's lanes stay together.
    expect(l.lanes.map((x) => x.id)).toEqual(['stream:e', 'stream:b', 'stream:a', 'stream:c', `repo:${APP}`, 'other'])
    const e = l.lanes.find((x) => x.id === 'stream:e')!
    expect(e.empty).toBe(true)
    expect(e.h).toBeLessThan(l.lanes.find((x) => x.id === 'stream:a')!.h)
    // The plan node is a card now, not an item in its parent's lane.
    expect(l.nodes.get(t.planA.id)!.lane).not.toBe('stream:g')
    noOverlaps(l)
  })

  it("centres a card on its subtree's lanes", () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, now: NOW })
    const lane = (id: string) => l.lanes.find((x) => x.id === `stream:${id}`)!
    const mid = (top: number, bottom: number) => (top + bottom) / 2
    const cy = (id: string) => cardOf(l, id).y + cardOf(l, id).h / 2
    expect(cy('c')).toBe(mid(lane('c').y, lane('c').y + lane('c').h))
    expect(cy('a')).toBe(mid(lane('a').y, lane('c').y + lane('c').h))
    expect(cy('g')).toBe(mid(lane('b').y, lane('c').y + lane('c').h))
    expect(cy('b')).toBe(mid(lane('b').y, lane('b').y + lane('b').h))
    expect(cy('e')).toBe(mid(lane('e').y, lane('e').y + lane('e').h))
    // Cards never overlap each other.
    const cards = [...l.nodes.values()].filter((p) => p.stream)
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++) expect(rectsOverlap(cards[i], cards[j])).toBe(false)
  })

  it('a focused subtree draws the picked node as the right-most root', () => {
    const t = treeGraph()
    // The panel passes the focus (the picked node and its sub-streams) as the canvas streams.
    const l = computeLayout({ ...t, workstreams: [t.c, t.a], now: NOW })
    expect([...l.tree.cards.values()].map((s) => s.id).sort()).toEqual(['a', 'c'])
    expect(cardOf(l, 'a').depth).toBe(0)
    expect(cardOf(l, 'a').x - cardOf(l, 'c').x).toBe(COL_W)
    expect(l.tree.links).toEqual([{ from: streamCardId('c'), to: t.planA.id }])
  })

  it('draws no tree without streams', () => {
    const t = treeGraph()
    const l = computeLayout({ ...t, workstreams: [], now: NOW })
    expect(l.tree.cards.size).toBe(0)
    expect([...l.nodes.values()].some((p) => p.stream)).toBe(false)
    expect(l.nodes.has(t.planA.id)).toBe(true)
  })

  it('places the same tree the same way whatever the input order', () => {
    const t = treeGraph()
    const a = computeLayout({ ...t, now: NOW })
    const b = computeLayout({ ...t, nodes: shuffled(t.nodes), now: NOW })
    expect([...b.nodes.entries()].sort()).toEqual([...a.nodes.entries()].sort())
  })
})

describe('helpers', () => {
  it('streamTree gives depths and cuts a parent cycle', () => {
    const t = streamTree([
      stream('b', 'B', { parentId: 'a' }),
      stream('a', 'A'),
      stream('x', 'X', { parentId: 'y' }),
      stream('y', 'Y', { parentId: 'x' })
    ])
    expect(t.order.map((s) => s.id)).toEqual(['a', 'b', 'x', 'y'])
    expect(Object.fromEntries(t.depth)).toEqual({ a: 0, b: 1, x: 0, y: 1 })
    expect(t.parent.get('b')).toBe('a')
    expect(t.parent.has('x')).toBe(false)
    expect(t.children.get('a')).toEqual(['b'])
  })

  it('activityColumn: stale changes sit next to "now", fresh ones towards the future', () => {
    expect(activityColumn(NOW - 40 * 86_400_000, NOW)).toBe(0)
    expect(activityColumn(NOW - 10 * 86_400_000, NOW)).toBe(1)
    expect(activityColumn(NOW - 5 * 86_400_000, NOW)).toBe(2)
    expect(activityColumn(NOW - 2 * 86_400_000, NOW)).toBe(3)
    expect(activityColumn(NOW - 3_600_000, NOW)).toBe(4)
  })

  it('orderStreams puts children after their parent and survives a parent cycle', () => {
    const s = orderStreams([
      stream('b', 'B', { parentId: 'a' }),
      stream('c', 'C'),
      stream('a', 'A'),
      stream('x', 'X', { parentId: 'y' }),
      stream('y', 'Y', { parentId: 'x' })
    ])
    expect(s.map((x) => x.id)).toEqual(['c', 'a', 'b', 'x', 'y'])
  })

  it('futureDepths terminates on a cycle', () => {
    const a = issue(CORE, 1)
    const b = issue(CORE, 2)
    const d = futureDepths([a, b], [edge(a, b, 'references'), edge(b, a, 'references')])
    expect(d.size).toBe(2)
  })

  it('branchAliases prefers the open change for a reused branch name', () => {
    const old = merged(CORE, 1, 5, { branch: { head: 'feat/y', base: 'dev' } })
    const open = change(CORE, 2, { branch: { head: 'feat/y', base: 'dev' } })
    const br: WorkNode = {
      ...change(CORE, 0),
      id: 'b',
      kind: 'branch',
      title: 'feat/y',
      branch: { head: 'feat/y', base: 'dev' }
    }
    expect(branchAliases([old, br, open]).get('b')).toBe(open.id)
  })
})
