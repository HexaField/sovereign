import { describe, expect, it } from 'vitest'
import { canvasStreams, orderEpics } from './epics-model.js'
import { applyFilters, hasActiveFilters, isOrphan } from './filters.js'
import { change, issue, merged, NOW, plan, stream, task } from './test-fixtures.js'
import { canPlace, leavesOf, placeOptions, progressLabel, streamPath, treeButtonLabel, treeRows } from './tree-model.js'

const R = 'demo-org/engine'

const goal = stream('g', 'Closed beta', { status: 'active' })
const auth = stream('a', 'Auth', { parentId: 'g', status: 'active' })
const revoke = stream('r', 'Revocation', { parentId: 'a', status: 'active' })
const events = stream('e', 'Events', { parentId: 'g', status: 'active' })
const loose = stream('l', 'Loose plan', { status: 'active' })
const all = [goal, auth, revoke, events, loose]

describe('paths and placement', () => {
  it('names a stream by its path from the goal', () => {
    expect(streamPath(all, 'r')).toEqual(['Closed beta', 'Auth', 'Revocation'])
    expect(streamPath(all, 'l')).toEqual(['Loose plan'])
    // A cycle stops at the first repeat.
    expect(streamPath([stream('x', 'X', { parentId: 'y' }), stream('y', 'Y', { parentId: 'x' })], 'x')).toEqual([
      'Y',
      'X'
    ])
  })

  it('a stream can go under any stream but itself and its own subtree, or to the top', () => {
    expect(canPlace(all, 'a', 'l')).toBe(true)
    expect(canPlace(all, 'a', null)).toBe(true)
    expect(canPlace(all, 'a', 'a')).toBe(false)
    expect(canPlace(all, 'a', 'r')).toBe(false)
    expect(canPlace(all, 'g', 'r')).toBe(false)
    // Where it already sits is no move.
    expect(canPlace(all, 'a', 'g')).toBe(false)
    expect(canPlace(all, 'g', null)).toBe(false)
  })

  it('offers every allowed parent in tree order, labelled by path', () => {
    expect(placeOptions(all, 'a')).toEqual([
      { id: 'g', label: 'Closed beta' },
      { id: 'e', label: 'Closed beta › Events' },
      { id: 'l', label: 'Loose plan' }
    ])
    // For a leaf (no stream id), every stream.
    expect(placeOptions(all).map((o) => o.id)).toEqual(['g', 'a', 'r', 'e', 'l'])
  })
})

describe('leaves', () => {
  it('lists a stream’s own PRs, issues and tasks: open first, then newest', () => {
    const nodes = [
      merged(R, 1, 3, { workstreams: ['a'] }),
      change(R, 2, { workstreams: ['a'], updatedAt: '2026-10-10T00:00:00Z' }),
      issue(R, 3, { workstreams: ['a'], updatedAt: '2026-10-12T00:00:00Z' }),
      task('t', { workstreams: ['a', 'l'] }),
      plan('p.md', { workstreams: ['a'] }),
      change(R, 4, { workstreams: ['r'] })
    ]
    expect(leavesOf('a', nodes).map((n) => n.id)).toEqual([
      'task:t',
      issue(R, 3).id,
      change(R, 2).id,
      merged(R, 1, 3).id
    ])
  })
})

describe('treeRows', () => {
  const nodes = [change(R, 2, { workstreams: ['a'] }), issue(R, 3, { workstreams: ['r'] })]
  const rows = orderEpics(all)

  it('shows sub-streams, hides leaves until a stream opens them', () => {
    const out = treeRows(rows, nodes, { collapsed: new Set(), openLeaves: new Set() })
    expect(out.map((r) => (r.kind === 'stream' ? r.stream.id : r.node.id))).toEqual(['g', 'a', 'r', 'e', 'l'])
    expect(out.find((r) => r.kind === 'stream' && r.stream.id === 'a')).toMatchObject({
      hasChildren: true,
      leaves: 1
    })
    const opened = treeRows(rows, nodes, { collapsed: new Set(), openLeaves: new Set(['a']) })
    expect(opened.map((r) => (r.kind === 'stream' ? r.stream.id : r.node.id))).toEqual([
      'g',
      'a',
      change(R, 2).id,
      'r',
      'e',
      'l'
    ])
    expect(opened[2]).toMatchObject({ kind: 'leaf', depth: 2, streamId: 'a' })
  })

  it('a collapsed stream hides its subtree', () => {
    const out = treeRows(rows, nodes, { collapsed: new Set(['g']), openLeaves: new Set(['a']) })
    expect(out.map((r) => (r.kind === 'stream' ? r.stream.id : r.node.id))).toEqual(['g', 'l'])
  })
})

describe('labels', () => {
  it('progress reads done/total, nothing without leaves', () => {
    expect(progressLabel({ done: 1, total: 6, blocked: 2 })).toBe('1/6')
    expect(progressLabel({ done: 0, total: 0, blocked: 0 })).toBe('')
    expect(progressLabel(undefined)).toBe('')
  })

  it('the button reads Tree (n), (picked/n), or the chosen statuses', () => {
    expect(treeButtonLabel({}, all)).toBe('Tree (5)')
    expect(treeButtonLabel({ workstreams: ['g'] }, all)).toBe('Tree (1/5)')
    expect(treeButtonLabel({ epicStatus: ['active'] }, all)).toBe('Tree: Active (5)')
  })
})

describe('the canvas draws the picked node’s subtree', () => {
  it('a picked goal draws itself and every stream below it, as one tree', () => {
    expect(canvasStreams({ workstreams: ['g'] }, all).map((s) => s.id)).toEqual(['g', 'a', 'r', 'e'])
  })

  it('with nothing selected every shown stream is drawn', () => {
    expect(canvasStreams({}, all)).toEqual(all)
  })
})

describe('orphans ("Not in a tree")', () => {
  it('keeps open PRs and issues no stream owns', () => {
    const nodes = [
      change(R, 1),
      change(R, 2, { state: 'draft' }),
      merged(R, 3, 2),
      issue(R, 4),
      issue(R, 5, { state: 'closed' }),
      change(R, 6, { workstreams: ['a'] }),
      task('t'),
      plan('p.md')
    ]
    expect(nodes.filter(isOrphan).map((n) => n.number ?? n.id)).toEqual([1, 2, 4])
    const r = applyFilters(nodes, { orphans: true }, { now: NOW })
    expect([...r.visible].sort()).toEqual([change(R, 1).id, change(R, 2).id, issue(R, 4).id].sort())
    expect(hasActiveFilters({ orphans: true })).toBe(true)
  })
})
