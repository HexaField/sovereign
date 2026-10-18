import { refKey, type Change, type ForgeIssue, type WorkEdge } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import { applyView, buildGraph, parsePaired, searchGraph, windowGraph, type BuildInput } from './build.js'
import { emptyCache } from './cache.js'
import type { Plan } from './plans.js'
import { change, issue } from './testing.js'
import type { PortTask, RepoCache } from './types.js'

const WIDGET = 'acme-labs/widget'
const GADGET = 'acme-labs/gadget'

function cacheOf(
  repo: string,
  changes: Change[],
  issues: ForgeIssue[] = [],
  branches: Record<string, string> = {}
): RepoCache {
  const c = emptyCache('github', 'github.com', repo)
  for (const x of changes) c.changes[x.ref.id] = { ...x, body: '', paired: parsePaired(x.body) }
  for (const x of issues) c.issues[x.ref.id] = { ...x, body: '' }
  c.branches = branches
  return c
}

const id = (repo: string, n: number) => `github:github.com/${repo}#${n}`
const has = (edges: WorkEdge[], from: string, to: string, kind: WorkEdge['kind']) =>
  edges.some((e) => e.from === from && e.to === to && e.kind === kind)

function task(over: Partial<PortTask> & { id: string }): PortTask {
  return {
    name: over.id,
    state: 'pending',
    threadId: null,
    transientState: null,
    membrane: 'acme',
    key: null,
    parentIds: [],
    childIds: [],
    isStream: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over
  }
}

const input = (over: Partial<BuildInput>): BuildInput => ({ repos: [], plans: [], tasks: [], related: [], ...over })

describe('parsePaired', () => {
  it('reads the refs of a "> ### Paired with:" block, short and URL forms', () => {
    const body = [
      'Adds the thing.',
      '',
      '> ### Paired with: acme-labs/gadget#12',
      '> also https://github.com/acme-labs/gadget/pull/14',
      '',
      'Unrelated acme-labs/gadget#99 outside the block'
    ].join('\n')
    expect(parsePaired(body).map(refKey)).toEqual([id(GADGET, 12), id(GADGET, 14)])
    expect(parsePaired('no block here acme-labs/gadget#1')).toEqual([])
  })
})

describe('buildGraph', () => {
  it('chains a stack of six changes by base branch; the bottom one sits on the branch node', () => {
    const stack: Change[] = []
    for (let i = 1; i <= 6; i++) {
      stack.push(
        change(WIDGET, 100 + i, {
          head: { branch: `stack/${i}`, sha: `s${i}` },
          base: { branch: i === 1 ? 'dev' : `stack/${i - 1}` }
        })
      )
    }
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, stack, [], { dev: 'd1', 'stack/1': 's1' })] }))
    for (let i = 2; i <= 6; i++) expect(has(g.edges, id(WIDGET, 100 + i), id(WIDGET, 99 + i), 'base')).toBe(true)
    const dev = 'github:github.com/acme-labs/widget@dev'
    expect(has(g.edges, id(WIDGET, 101), dev, 'base')).toBe(true)
    expect(g.nodes.find((n) => n.id === dev)).toMatchObject({
      kind: 'branch',
      zone: 'present',
      state: 'open',
      title: 'dev'
    })
    expect(g.edges.filter((e) => e.kind === 'base')).toHaveLength(6)
    expect(g.edges.every((e) => !e.dashed || e.kind !== 'base')).toBe(true)
  })

  it('sends changes into an integration branch to the branch, not to its release change', () => {
    const dev = 'github:github.com/acme-labs/widget@dev'
    const early = change(WIDGET, 10, {
      state: 'merged',
      createdAt: '2026-09-01T00:00:00Z',
      closedAt: '2026-09-02T00:00:00Z'
    })
    const release = change(WIDGET, 20, {
      head: { branch: 'dev', sha: 'r' },
      base: { branch: 'staging' },
      createdAt: '2026-10-01T00:00:00Z'
    })
    const later = change(WIDGET, 30, { createdAt: '2026-10-05T00:00:00Z' })
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, [early, release, later])] }))
    expect(has(g.edges, id(WIDGET, 10), dev, 'merged-into')).toBe(true)
    expect(has(g.edges, id(WIDGET, 30), dev, 'base')).toBe(true)
    expect(g.edges.some((e) => e.to === id(WIDGET, 20))).toBe(false)
  })

  it('prefers the open change when two changes share a head branch, and links merges with merged-into', () => {
    const old = change(WIDGET, 1, {
      head: { branch: 'feat/a', sha: 'x' },
      state: 'closed',
      closedAt: '2026-09-01T00:00:00Z'
    })
    const live = change(WIDGET, 2, { head: { branch: 'feat/a', sha: 'y' } })
    const onTop = change(WIDGET, 3, { base: { branch: 'feat/a' } })
    const merged = change(WIDGET, 4, { state: 'merged', closedAt: '2026-10-02T00:00:00Z' })
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, [old, live, onTop, merged])] }))
    expect(has(g.edges, id(WIDGET, 3), id(WIDGET, 2), 'base')).toBe(true)
    expect(has(g.edges, id(WIDGET, 4), 'github:github.com/acme-labs/widget@dev', 'merged-into')).toBe(true)
    // A closed change has no branch edge.
    expect(g.edges.some((e) => e.from === id(WIDGET, 1))).toBe(false)
  })

  it('pairs changes across repos once, whichever side names the other', () => {
    const w = change(WIDGET, 159, { body: '> ### Paired with: acme-labs/gadget#712' })
    const g2 = change(GADGET, 712, { body: '> ### Paired with: acme-labs/widget#159' })
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, [w]), cacheOf(GADGET, [g2])] }))
    const paired = g.edges.filter((e) => e.kind === 'paired')
    expect(paired).toHaveLength(1)
    expect([paired[0].from, paired[0].to].sort()).toEqual([id(GADGET, 712), id(WIDGET, 159)].sort())
    expect(paired[0].dashed).toBe(false)
  })

  it('drops edges to items outside the membrane (a paired PR in a repo it does not cover)', () => {
    const w = change(WIDGET, 5, { body: '> ### Paired with: other-org/elsewhere#1' })
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, [w])] }))
    expect(g.edges.filter((e) => e.kind === 'paired')).toEqual([])
  })

  it('assigns zones: past = merged/closed, present = open change and branch, future = open issue, plan, planned task', () => {
    const repos = [
      cacheOf(
        WIDGET,
        [
          change(WIDGET, 1),
          change(WIDGET, 2, { state: 'draft' }),
          change(WIDGET, 3, { state: 'merged' }),
          change(WIDGET, 4, { state: 'closed' })
        ],
        [issue(WIDGET, 10), issue(WIDGET, 11, { state: 'closed', closedReason: 'completed' })]
      )
    ]
    const plans: Plan[] = [
      {
        id: 'plan:acme/a.md',
        project: 'acme',
        file: '/x/a.md',
        title: 'A',
        status: 'planned',
        refs: [],
        hash: 'h',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z'
      },
      {
        id: 'plan:acme/b.md',
        project: 'acme',
        file: '/x/b.md',
        title: 'B',
        status: 'done',
        refs: [],
        hash: 'h',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z'
      }
    ]
    const tasks = [
      task({ id: 't1', name: 'Decide the gate box' }),
      task({ id: 't2', state: 'completed' }),
      task({ id: 't3', state: 'paused' })
    ]
    const g = buildGraph(input({ repos, plans, tasks }))
    const zone = (nid: string) => g.nodes.find((n) => n.id === nid)?.zone
    expect([zone(id(WIDGET, 1)), zone(id(WIDGET, 2)), zone(id(WIDGET, 3)), zone(id(WIDGET, 4))]).toEqual([
      'present',
      'present',
      'past',
      'past'
    ])
    expect([zone(id(WIDGET, 10)), zone(id(WIDGET, 11))]).toEqual(['future', 'past'])
    expect([zone('plan:acme/a.md'), zone('plan:acme/b.md')]).toEqual(['future', 'past'])
    expect(g.nodes.find((n) => n.id === 'task:t1')).toMatchObject({
      kind: 'task',
      zone: 'future',
      state: 'planned',
      forge: 'local',
      title: 'Decide the gate box'
    })
    expect(zone('task:t2')).toBe('past')
    expect(g.nodes.find((n) => n.id === 'task:t3')).toMatchObject({ state: 'paused', zone: 'future' })
  })

  it('links closes (dashed while the issue is open), references (from the mentioning item) and plans', () => {
    const c = change(WIDGET, 1, {
      closes: [{ forge: 'github', host: 'github.com', repo: WIDGET, kind: 'issue', id: '10' }]
    })
    const i10 = issue(WIDGET, 10, {
      references: [{ forge: 'github', host: 'github.com', repo: WIDGET, kind: 'change', id: '1' }]
    })
    const i11 = issue(WIDGET, 11, {
      state: 'closed',
      references: [{ forge: 'github', host: 'github.com', repo: WIDGET, kind: 'issue', id: '10' }]
    })
    const plan: Plan = {
      id: 'plan:acme/p.md',
      project: 'acme',
      file: '/p.md',
      title: 'P',
      status: 'planned',
      refs: [
        { host: 'github.com', repo: WIDGET, number: 1 },
        { host: 'github.com', repo: WIDGET, number: 11 }
      ],
      hash: 'h',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z'
    }
    const c2 = change(WIDGET, 2, {
      closes: [{ forge: 'github', host: 'github.com', repo: WIDGET, kind: 'issue', id: '11' }]
    })
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, [c, c2], [i10, i11])], plans: [plan] }))
    expect(g.edges.find((e) => e.kind === 'closes' && e.to === id(WIDGET, 10))?.dashed).toBe(true)
    expect(g.edges.find((e) => e.kind === 'closes' && e.to === id(WIDGET, 11))?.dashed).toBe(false)
    // The change also cross-references the issue it closes: closes says more, so no references edge.
    expect(has(g.edges, id(WIDGET, 1), id(WIDGET, 10), 'references')).toBe(false)
    expect(has(g.edges, id(WIDGET, 10), id(WIDGET, 11), 'references')).toBe(true)
    expect(has(g.edges, 'plan:acme/p.md', id(WIDGET, 1), 'plans')).toBe(true)
    expect(has(g.edges, 'plan:acme/p.md', id(WIDGET, 11), 'plans')).toBe(true)
  })

  it("relates what a plan names to the plan's epic; owning beats related, and a plan with no epic relates nothing", () => {
    const plan = (pid: string, numbers: number[]): Plan => ({
      id: pid,
      project: 'acme',
      file: `/${pid}`,
      title: pid,
      status: 'in_progress',
      refs: numbers.map((number) => ({ host: 'github.com', repo: WIDGET, number })),
      hash: 'h',
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z'
    })
    const repos = [cacheOf(WIDGET, [change(WIDGET, 1), change(WIDGET, 2)], [issue(WIDGET, 10)])]
    const epic = task({
      id: 'task://epic',
      key: 'plan:acme/p.md',
      kind: 'plan',
      isStream: true,
      childIds: ['task://t2']
    })
    const tasks = [
      epic,
      task({ id: 'task://t2', key: id(WIDGET, 2), kind: 'change', parentIds: [epic.id] }),
      task({ id: 'task://loose', key: 'plan:acme/q.md', kind: 'plan' })
    ]
    const g = buildGraph(
      input({ repos, tasks, plans: [plan('plan:acme/p.md', [1, 2, 10, 99]), plan('plan:acme/q.md', [1])] })
    )
    const node = (nid: string) => g.nodes.find((n) => n.id === nid)!
    expect(node(id(WIDGET, 1))).toMatchObject({ workstreams: [], relatedStreams: [epic.id] })
    expect(node(id(WIDGET, 10))).toMatchObject({ workstreams: [], relatedStreams: [epic.id] })
    expect(node(id(WIDGET, 2))).toMatchObject({ workstreams: [epic.id] })
    expect(node(id(WIDGET, 2))).not.toHaveProperty('relatedStreams')
  })

  it('attaches tasks: taskId, status line, work streams; subtask edges between task nodes; related edges with their source', () => {
    const repos = [cacheOf(WIDGET, [change(WIDGET, 1)], [issue(WIDGET, 10)])]
    const tasks = [
      task({ id: 'stream', isStream: true, name: 'Plan 20', childIds: ['tc', 'parent'] }),
      task({
        id: 'tc',
        key: id(WIDGET, 1),
        parentIds: ['stream', 'parent'],
        transientState: 'CI red: build',
        threadId: 'th1'
      }),
      task({ id: 'parent', name: 'Decide', parentIds: ['stream'], childIds: ['tc'] })
    ]
    const related = [
      {
        from: id(WIDGET, 1),
        to: id(WIDGET, 10),
        kind: 'related' as const,
        reason: 'same bug',
        confidence: 0.8,
        source: 'rethink' as const,
        accepted: false,
        createdAt: ''
      },
      {
        from: id(WIDGET, 10),
        to: 'task:parent',
        kind: 'related' as const,
        source: 'rethink' as const,
        accepted: true,
        createdAt: ''
      }
    ]
    const g = buildGraph(input({ repos, tasks, related }))
    const c = g.nodes.find((n) => n.id === id(WIDGET, 1))!
    expect(c).toMatchObject({ taskId: 'tc', status: 'CI red: build', workstreams: ['stream'] })
    expect(g.nodes.find((n) => n.id === 'task:parent')?.workstreams).toEqual(['stream'])
    // The stream itself is a lane, not a node.
    expect(g.nodes.some((n) => n.id === 'task:stream')).toBe(false)
    expect(has(g.edges, 'task:parent', id(WIDGET, 1), 'subtask')).toBe(true)
    const r = g.edges.filter((e) => e.kind === 'related')
    expect(r.find((e) => e.to === id(WIDGET, 10))).toMatchObject({
      dashed: true,
      source: 'rethink',
      reason: 'same bug',
      confidence: 0.8
    })
    expect(r.find((e) => e.to === 'task:parent')?.source).toBe('user')
  })

  it('marks a base branch the last branch list lacks as gone (past)', () => {
    const m = change(WIDGET, 7, { state: 'merged', base: { branch: 'release/1' }, closedAt: '2026-10-03T00:00:00Z' })
    const g = buildGraph(input({ repos: [cacheOf(WIDGET, [m], [], { dev: 'd' })] }))
    expect(g.nodes.find((n) => n.id.endsWith('@release/1'))).toMatchObject({
      state: 'closed',
      zone: 'past',
      closedAt: '2026-10-03T00:00:00Z'
    })
  })
})

describe('windowGraph / applyView / searchGraph', () => {
  const repos = [
    cacheOf(WIDGET, [
      change(WIDGET, 1, {
        state: 'merged',
        closedAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
        title: 'Old merged sprocket'
      }),
      change(WIDGET, 2, { state: 'merged', closedAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' }),
      change(WIDGET, 3, {
        author: 'kit-bot',
        labels: ['perf'],
        reviewers: [{ login: 'hex-agent', state: 'requested' }]
      })
    ]),
    cacheOf(GADGET, [change(GADGET, 9, { head: { branch: 'feat/teeth', sha: 'z' } })])
  ]
  const g = buildGraph(input({ repos }))
  const now = Date.parse('2026-10-16T00:00:00Z')

  it('serves past nodes inside the window plus everything open; an older window serves only the past', () => {
    const w = windowGraph(g, '2026-09-25T00:00:00Z', '2026-10-16T00:00:00Z', now)
    const ids = w.nodes.map((n) => n.id)
    expect(ids).toContain(id(WIDGET, 2))
    expect(ids).toContain(id(WIDGET, 3))
    expect(ids).not.toContain(id(WIDGET, 1))
    const older = windowGraph(g, '2026-08-15T00:00:00Z', '2026-09-25T00:00:00Z', now)
    expect(older.nodes.map((n) => n.id)).toEqual([id(WIDGET, 1)])
    expect(w.edges.every((e) => ids.includes(e.from) && ids.includes(e.to))).toBe(true)
  })

  it('keeps an item the forge stamped ahead of this clock when the window reaches now', () => {
    const ahead = buildGraph(
      input({
        repos: [
          cacheOf(WIDGET, [
            change(WIDGET, 8, { state: 'merged', closedAt: '2026-10-16T00:00:05Z', updatedAt: '2026-10-16T00:00:05Z' })
          ])
        ]
      })
    )
    expect(windowGraph(ahead, '2026-09-25T00:00:00Z', '2026-10-16T00:00:00Z', now).nodes.map((n) => n.id)).toContain(
      id(WIDGET, 8)
    )
    // An older window keeps its upper bound.
    expect(windowGraph(ahead, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', now).nodes).toEqual([])
  })

  it('applies a view: its repos, then its filters; dim keeps every node', () => {
    const v = { id: 'v', membrane: 'acme', title: 'mine', repos: [WIDGET], filters: { authors: ['kit-bot'] } }
    expect(applyView(g, v).nodes.map((n) => n.id)).toEqual([id(WIDGET, 3)])
    expect(
      applyView(g, { ...v, filters: { requestedFromMe: true } }, { me: 'hex-agent' }).nodes.map((n) => n.id)
    ).toEqual([id(WIDGET, 3)])
    expect(applyView(g, { ...v, repos: [], filters: { labels: ['PERF'] } }).nodes.map((n) => n.id)).toEqual([
      id(WIDGET, 3)
    ])
    expect(applyView(g, { ...v, filters: { dim: true, authors: ['nobody'] } }).nodes).toHaveLength(g.nodes.length)
    // Selected epics narrow on the client (with their neighbours), never in the served window.
    expect(applyView(g, { ...v, repos: [], filters: { workstreams: ['no-such-stream'] } }).nodes).toHaveLength(
      g.nodes.length
    )
  })

  it('searches title, number, branch and author across the full history', () => {
    expect(searchGraph(g, 'sprocket').nodes.map((n) => n.id)).toEqual([id(WIDGET, 1)])
    expect(searchGraph(g, '#9').nodes.map((n) => n.id)).toEqual([id(GADGET, 9)])
    expect(searchGraph(g, 'teeth').nodes.map((n) => n.id)).toEqual([id(GADGET, 9)])
    expect(searchGraph(g, 'kit-bot').nodes.map((n) => n.id)).toEqual([id(WIDGET, 3)])
    expect(searchGraph(g, 'zzz-nothing').nodes).toEqual([])
  })
})
