import type { WorkEdge, WorkNode, WorkStream } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import { blockedLeaves, leafState, streamProgress, withProgress } from './tree.js'

const R = 'acme-labs/widget'
const id = (n: number) => `github:github.com/${R}#${n}`

function node(over: Partial<WorkNode> & Pick<WorkNode, 'id' | 'kind' | 'state'>): WorkNode {
  return {
    forge: over.kind === 'task' || over.kind === 'plan' ? 'local' : 'github',
    title: over.id,
    zone: 'present',
    assignees: [],
    reviewers: [],
    labels: [],
    workstreams: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over
  }
}
const pr = (n: number, state: WorkNode['state'], ws: string[] = []) =>
  node({ id: id(n), kind: 'change', state, repo: R, number: n, workstreams: ws })
const iss = (n: number, state: WorkNode['state'], ws: string[] = [], over: Partial<WorkNode> = {}) =>
  node({ id: id(n), kind: 'issue', state, repo: R, number: n, workstreams: ws, ...over })
const stream = (sid: string, parentId?: string, over: Partial<WorkStream> = {}): WorkStream => ({
  id: sid,
  name: sid,
  membrane: 'acme',
  memberCount: 0,
  status: 'active',
  ...(parentId ? { parentId } : {}),
  ...over
})
const edge = (from: string, to: string, kind: WorkEdge['kind']): WorkEdge => ({
  from,
  to,
  kind,
  dashed: false,
  source: 'sync'
})

describe('leafState', () => {
  it('maps PRs, issues and tasks to done / cancelled / open; plans and branches are no leaves', () => {
    expect(leafState(pr(1, 'merged'))).toBe('done')
    expect(leafState(pr(1, 'closed'))).toBe('cancelled')
    expect(leafState(pr(1, 'draft'))).toBe('open')
    expect(leafState(iss(2, 'closed', [], { closedReason: 'completed' }))).toBe('done')
    expect(leafState(iss(2, 'closed'))).toBe('done')
    expect(leafState(iss(2, 'closed', [], { closedReason: 'not_planned' }))).toBe('cancelled')
    expect(leafState(iss(2, 'open'))).toBe('open')
    expect(leafState(node({ id: 'task:a', kind: 'task', state: 'done' }))).toBe('done')
    expect(leafState(node({ id: 'task:a', kind: 'task', state: 'cancelled' }))).toBe('cancelled')
    expect(leafState(node({ id: 'task:a', kind: 'task', state: 'paused' }))).toBe('open')
    expect(leafState(node({ id: 'plan:a/x.md', kind: 'plan', state: 'planned' }))).toBeUndefined()
    expect(leafState(node({ id: `github:github.com/${R}@x`, kind: 'branch', state: 'open' }))).toBeUndefined()
  })
})

describe('streamProgress', () => {
  it('counts leaves over the whole subtree: done of total, cancelled left out', () => {
    const streams = [stream('goal'), stream('node', 'goal'), stream('leafy', 'node'), stream('other')]
    const nodes = [
      pr(1, 'merged', ['goal']),
      pr(2, 'open', ['node']),
      iss(3, 'closed', ['leafy'], { closedReason: 'completed' }),
      iss(4, 'closed', ['leafy'], { closedReason: 'not_planned' }),
      node({ id: 'task:t', kind: 'task', state: 'planned', workstreams: ['leafy', 'other'] }),
      node({ id: 'plan:acme/p.md', kind: 'plan', state: 'planned', workstreams: ['goal'] }),
      pr(9, 'open')
    ]
    const p = streamProgress(streams, nodes, [])
    expect(p.get('goal')).toEqual({ done: 2, total: 4, blocked: 0 })
    expect(p.get('node')).toEqual({ done: 1, total: 3, blocked: 0 })
    expect(p.get('leafy')).toEqual({ done: 1, total: 2, blocked: 0 })
    expect(p.get('other')).toEqual({ done: 0, total: 1, blocked: 0 })
  })

  it('a task-only task in two streams of one subtree counts once', () => {
    const streams = [stream('goal'), stream('a', 'goal'), stream('b', 'goal')]
    const nodes = [node({ id: 'task:t', kind: 'task', state: 'done', workstreams: ['a', 'b'] })]
    expect(streamProgress(streams, nodes, []).get('goal')).toEqual({ done: 1, total: 1, blocked: 0 })
  })

  it('blocked: an open PR on another open PR, and an open issue whose open closing PRs are all blocked', () => {
    const streams = [stream('goal')]
    const nodes = [
      pr(1, 'open', ['goal']), // the bottom of a stack
      pr(2, 'draft', ['goal']), // stacked on #1
      pr(3, 'open', ['goal']), // stacked on a merged PR: not blocked
      pr(4, 'merged'),
      iss(5, 'open', ['goal']), // closed by #2 (blocked)
      iss(6, 'open', ['goal']), // closed by #1 (not blocked)
      iss(7, 'open', ['goal']) // nothing closes it
    ]
    const edges = [
      edge(id(2), id(1), 'base'),
      edge(id(3), id(4), 'base'),
      edge(id(2), id(5), 'closes'),
      edge(id(1), id(6), 'closes')
    ]
    // #2 rides on #5 (its leaf issue) and #1 on #6, so the leaves are #3, #5, #6, #7.
    expect(streamProgress(streams, nodes, edges).get('goal')).toEqual({ done: 0, total: 4, blocked: 1 })
  })

  it('a PR that closes a leaf issue of the same subtree is not a leaf of its own', () => {
    const streams = [stream('goal'), stream('node', 'goal')]
    const nodes = [iss(5, 'closed', ['node'], { closedReason: 'completed' }), pr(2, 'merged', ['goal'])]
    const edges = [edge(id(2), id(5), 'closes')]
    expect(streamProgress(streams, nodes, edges).get('goal')).toEqual({ done: 1, total: 1, blocked: 0 })
    // In a stream whose subtree does not hold the issue, the PR is its own leaf.
    const apart = [stream('a'), stream('b')]
    const nodes2 = [iss(5, 'open', ['a']), pr(2, 'merged', ['b'])]
    const p = streamProgress(apart, nodes2, edges)
    expect(p.get('a')).toEqual({ done: 0, total: 1, blocked: 0 })
    expect(p.get('b')).toEqual({ done: 1, total: 1, blocked: 0 })
  })

  it('archived sub-streams leave their parent’s roll-up; an archived stream still counts its own', () => {
    const streams = [stream('goal'), stream('old', 'goal', { status: 'archived' })]
    const nodes = [pr(1, 'merged', ['goal']), pr(2, 'open', ['old'])]
    const p = streamProgress(streams, nodes, [])
    expect(p.get('goal')).toEqual({ done: 1, total: 1, blocked: 0 })
    expect(p.get('old')).toEqual({ done: 0, total: 1, blocked: 0 })
  })

  it('a parent cycle does not loop', () => {
    const streams = [stream('a', 'b'), stream('b', 'a')]
    const nodes = [pr(1, 'open', ['a']), pr(2, 'merged', ['b'])]
    const p = streamProgress(streams, nodes, [])
    expect(p.get('a')).toEqual({ done: 1, total: 2, blocked: 0 })
    expect(p.get('b')).toEqual({ done: 1, total: 2, blocked: 0 })
  })

  describe('depends-on', () => {
    it('node → node: an open target blocks the dependent; a merged or cancelled one does not', () => {
      const streams = [stream('goal')]
      const nodes = [
        pr(1, 'open', ['goal']), // waits on #2 (open)
        pr(2, 'open'),
        pr(3, 'open', ['goal']), // waits on #4 (merged)
        pr(4, 'merged'),
        iss(5, 'open', ['goal']), // waits on #6 (closed, not planned)
        iss(6, 'closed', [], { closedReason: 'not_planned' }),
        node({ id: 'task:t', kind: 'task', state: 'planned', workstreams: ['goal'] }) // waits on task:u (planned)
      ]
      const nodes2 = [...nodes, node({ id: 'task:u', kind: 'task', state: 'planned' })]
      const edges = [
        edge(id(1), id(2), 'depends-on'),
        edge(id(3), id(4), 'depends-on'),
        edge(id(5), id(6), 'depends-on'),
        edge('task:t', 'task:u', 'depends-on')
      ]
      expect([...blockedLeaves(nodes2, edges, streams)].sort()).toEqual([id(1), 'task:t'].sort())
      expect(streamProgress(streams, nodes2, edges).get('goal')).toEqual({ done: 0, total: 4, blocked: 2 })
    })

    it('node → stream: blocked while a leaf of the stream’s subtree is open', () => {
      const streams = [stream('a'), stream('b'), stream('b2', 'b')]
      const open = [pr(1, 'open', ['a']), pr(2, 'merged', ['b']), iss(3, 'open', ['b2'])]
      const edges = [edge(id(1), 'b', 'depends-on')]
      expect(blockedLeaves(open, edges, streams)).toEqual(new Set([id(1)]))
      expect(streamProgress(streams, open, edges).get('a')).toEqual({ done: 0, total: 1, blocked: 1 })
      const done = [pr(1, 'open', ['a']), pr(2, 'merged', ['b']), iss(3, 'closed', ['b2'])]
      expect(blockedLeaves(done, edges, streams).size).toBe(0)
    })

    it('stream → stream: every open leaf of the dependent stream waits until the needed stream’s leaves are done', () => {
      const streams = [stream('first'), stream('next'), stream('next-sub', 'next')]
      const before = [
        pr(1, 'open', ['first']),
        pr(2, 'open', ['next']),
        iss(3, 'open', ['next-sub']),
        pr(4, 'merged', ['next'])
      ]
      const edges = [edge('next', 'first', 'depends-on')]
      expect(blockedLeaves(before, edges, streams)).toEqual(new Set([id(2), id(3)]))
      expect(streamProgress(streams, before, edges).get('next')).toEqual({ done: 1, total: 3, blocked: 2 })
      const after = [pr(1, 'merged', ['first']), ...before.slice(1)]
      expect(blockedLeaves(after, edges, streams).size).toBe(0)
    })

    it('an archived stream target does not block', () => {
      const streams = [stream('a'), stream('old', undefined, { status: 'archived' })]
      const nodes = [pr(1, 'open', ['a']), pr(2, 'open', ['old'])]
      expect(blockedLeaves(nodes, [edge(id(1), 'old', 'depends-on')], streams).size).toBe(0)
    })
  })

  it('withProgress sets each stream’s progress', () => {
    const out = withProgress([stream('goal')], [pr(1, 'merged', ['goal'])], [])
    expect(out[0]).toMatchObject({ id: 'goal', progress: { done: 1, total: 1, blocked: 0 } })
  })
})
