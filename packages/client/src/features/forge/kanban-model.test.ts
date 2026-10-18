import { describe, expect, it } from 'vitest'
import type { AgentOverlay, ForgeFilters, WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { epicFocus, panelShown, panelVisibility } from './epics-model.js'
import { applyFilters } from './filters.js'
import { KANBAN_COLUMNS, kanbanCards, kanbanColumn, parseForgeMode, type KanbanColumn } from './kanban-model.js'
import { NOW, change, edge, issue, iso, merged, plan, stream, task } from './test-fixtures.js'

const REPO = 'acme/widgets'

it('orders the columns left → right by progress', () => {
  expect(KANBAN_COLUMNS.map((c) => c.id)).toEqual(['todo', 'in-progress', 'needs-work', 'in-review', 'ready'])
})

function board(
  nodes: WorkNode[],
  edges: WorkEdge[] = [],
  opts: { shown?: Set<string>; overlays?: AgentOverlay[]; streams?: WorkStream[] } = {}
) {
  return kanbanCards({
    nodesById: new Map(nodes.map((n) => [n.id, n])),
    edges,
    shown: opts.shown ?? new Set(nodes.map((n) => n.id)),
    overlays: new Map((opts.overlays ?? []).map((o) => [o.nodeId, o])),
    streams: opts.streams ?? []
  })
}

const ids = (cols: ReturnType<typeof board>, c: KanbanColumn): number[] =>
  (cols.get(c) ?? []).map((k) => k.node.number!)

const overlay = (nodeId: string, over: Partial<AgentOverlay> = {}): AgentOverlay => ({ nodeId, subagents: [], ...over })

describe('kanbanColumn', () => {
  it('ready to merge: open, approved, CI passing or none, no conflict', () => {
    const approved = [{ login: 'kim', state: 'approved' as const }]
    expect(kanbanColumn(change(REPO, 1, { reviewers: approved, ci: 'passing' }), undefined)).toBe('ready')
    expect(kanbanColumn(change(REPO, 1, { reviewers: approved }), undefined)).toBe('ready')
    expect(kanbanColumn(change(REPO, 1, { reviewers: approved, ci: 'none' }), undefined)).toBe('ready')
    // Pending CI is not ready yet, and not failing either.
    expect(kanbanColumn(change(REPO, 1, { reviewers: approved, ci: 'pending' }), undefined)).toBe('in-review')
  })

  it('needs work beats ready: changes requested, failing CI or a conflict', () => {
    const both = [
      { login: 'kim', state: 'approved' as const },
      { login: 'lee', state: 'changes_requested' as const }
    ]
    expect(kanbanColumn(change(REPO, 1, { reviewers: both }), undefined)).toBe('needs-work')
    const approved = [{ login: 'kim', state: 'approved' as const }]
    expect(kanbanColumn(change(REPO, 1, { reviewers: approved, ci: 'failing' }), undefined)).toBe('needs-work')
    expect(
      kanbanColumn(
        change(REPO, 1, { reviewers: approved, branch: { head: 'h', base: 'dev', conflict: true } }),
        undefined
      )
    ).toBe('needs-work')
  })

  it('a draft is never ready; needs work when failing, else in progress', () => {
    const approved = [{ login: 'kim', state: 'approved' as const }]
    expect(kanbanColumn(change(REPO, 1, { state: 'draft', reviewers: approved }), undefined)).toBe('in-progress')
    expect(kanbanColumn(change(REPO, 1, { state: 'draft', ci: 'failing' }), undefined)).toBe('needs-work')
  })

  it('an open PR otherwise is in review', () => {
    expect(kanbanColumn(change(REPO, 1), undefined)).toBe('in-review')
    expect(kanbanColumn(change(REPO, 1, { reviewers: [{ login: 'kim', state: 'requested' }] }), undefined)).toBe(
      'in-review'
    )
  })

  it('an issue is in progress with an owner thread, a subagent or an assignee; else to do', () => {
    const i = issue(REPO, 9)
    expect(kanbanColumn(i, undefined)).toBe('todo')
    expect(kanbanColumn(i, overlay(i.id))).toBe('todo')
    expect(kanbanColumn(i, overlay(i.id, { thread: { id: 't', label: 'fix', status: 'idle' } }))).toBe('in-progress')
    expect(kanbanColumn(i, overlay(i.id, { subagents: [{ key: 's', label: 'sub', startedAt: NOW }] }))).toBe(
      'in-progress'
    )
    expect(kanbanColumn(issue(REPO, 9, { assignees: ['alex'] }), undefined)).toBe('in-progress')
  })
})

describe('kanbanCards', () => {
  it('only open PRs and open issues get cards', () => {
    const cols = board([
      change(REPO, 1),
      change(REPO, 2, { state: 'draft' }),
      merged(REPO, 3, 1),
      change(REPO, 4, { state: 'closed' }),
      issue(REPO, 5),
      issue(REPO, 6, { state: 'closed' }),
      plan('docs/plan.md'),
      task('t1')
    ])
    const all = [...cols.values()].flat().map((c) => c.node.number)
    expect(all.sort()).toEqual([1, 2, 5])
  })

  it('shows only the bottom of a stack, with the stack size', () => {
    const bottom = change(REPO, 10)
    const mid = change(REPO, 11)
    const top = change(REPO, 12, { state: 'draft' })
    const side = change(REPO, 13)
    const devBranch = `github:github.com/${REPO}@dev`
    const cols = board(
      [bottom, mid, top, side],
      [edge(bottom, devBranch, 'base'), edge(mid, bottom, 'base'), edge(top, mid, 'base'), edge(side, bottom, 'base')]
    )
    const cards = [...cols.values()].flat()
    expect(cards.map((c) => c.node.number)).toEqual([10])
    expect(cards[0].stack).toBe(4)
  })

  it('a PR based on a merged or closed PR is not blocked', () => {
    const base = merged(REPO, 20, 1)
    const pr = change(REPO, 21)
    const cols = board([base, pr], [edge(pr, base, 'base')])
    expect(ids(cols, 'in-review')).toEqual([21])
    expect(cols.get('in-review')![0].stack).toBe(1)
  })

  it('a stacked PR stays blocked when its base is filtered out of view', () => {
    const base = change(REPO, 30, { author: 'kim' })
    const pr = change(REPO, 31)
    const cols = board([base, pr], [edge(pr, base, 'base')], { shown: new Set([pr.id]) })
    expect([...cols.values()].flat()).toEqual([])
  })

  it('folds an issue an open PR closes into that PR, and into the bottom of its stack', () => {
    const i1 = issue(REPO, 40)
    const i2 = issue('acme/gears', 41)
    const i3 = issue(REPO, 42) // closed by a merged PR: still its own card
    const i4 = issue(REPO, 43)
    const bottom = change(REPO, 50)
    const top = change(REPO, 51)
    const old = merged(REPO, 52, 2)
    const cols = board(
      [i1, i2, i3, i4, bottom, top, old],
      [
        edge(bottom, i1, 'closes'),
        edge(top, i2, 'closes'),
        edge(old, i3, 'closes'),
        edge(bottom, i4, 'references'),
        edge(top, bottom, 'base')
      ]
    )
    expect(ids(cols, 'todo').sort()).toEqual([42, 43])
    const card = cols.get('in-review')!.find((c) => c.node.number === 50)!
    expect(card.closes).toEqual(['#40', 'acme/gears#41'])
  })

  it('sorts each column by last update, newest first', () => {
    const cols = board([
      issue(REPO, 1, { updatedAt: iso(5) }),
      issue(REPO, 2, { updatedAt: iso(1) }),
      issue(REPO, 3, { updatedAt: iso(3) })
    ])
    expect(ids(cols, 'todo')).toEqual([2, 3, 1])
  })

  it('names the owning epic and keeps every column, empty or not', () => {
    const s = stream('task://s1', 'Billing')
    const cols = board([issue(REPO, 1, { workstreams: [s.id] })], [], { streams: [s] })
    expect(cols.get('todo')![0].epic).toBe('Billing')
    expect([...cols.keys()]).toEqual(['ready', 'needs-work', 'in-review', 'in-progress', 'todo'])
  })

  it('lists what the panel shows: the same filters and epic focus as the canvas', () => {
    const s = stream('task://s1', 'Billing')
    const nodes = [
      change(REPO, 1, { workstreams: [s.id] }),
      change(REPO, 2, { author: 'kim', workstreams: [s.id] }),
      change(REPO, 3),
      issue(REPO, 4, { relatedStreams: [s.id] })
    ]
    const shownFor = (f: ForgeFilters): Set<string> => {
      const filtered = applyFilters(nodes, f, { overlays: new Map(), now: NOW })
      return panelShown(panelVisibility(filtered, epicFocus(f, [s], nodes, []), f.dim))
    }
    const numbers = (f: ForgeFilters): number[] =>
      [...board(nodes, [], { shown: shownFor(f), streams: [s] }).values()]
        .flat()
        .map((c) => c.node.number!)
        .sort()

    expect(numbers({})).toEqual([1, 2, 3, 4])
    expect(numbers({ authors: ['alex'] })).toEqual([1, 3])
    expect(numbers({ workstreams: [s.id] })).toEqual([1, 2])
    expect(numbers({ workstreams: [s.id], epicRelated: true })).toEqual([1, 2, 4])
    // Dim mode fades what the filters drop on the canvas; the Kanban leaves it out.
    expect(numbers({ workstreams: [s.id], authors: ['alex'], dim: true })).toEqual([1])
  })
})

describe('panelVisibility', () => {
  const filtered = { visible: new Set(['a', 'b', 'c']), dimmed: new Set<string>() }
  it('passes the filter result through without a focus', () => {
    expect(panelVisibility(filtered, null, false)).toEqual(filtered)
  })
  it('narrows to the focus, or dims the rest in dim mode', () => {
    expect([...panelVisibility(filtered, new Set(['a']), false).visible]).toEqual(['a'])
    const dimmed = panelVisibility(filtered, new Set(['a']), true)
    expect([...dimmed.visible]).toEqual(['a', 'b', 'c'])
    expect([...panelShown(dimmed)]).toEqual(['a'])
  })
})

describe('parseForgeMode', () => {
  it('defaults to the graph', () => {
    expect(parseForgeMode('kanban')).toBe('kanban')
    expect(parseForgeMode('graph')).toBe('graph')
    expect(parseForgeMode(null)).toBe('graph')
    expect(parseForgeMode('other')).toBe('graph')
  })
})
