import { describe, expect, it } from 'vitest'
import {
  clearEpics,
  epicCounts,
  epicFocus,
  epicSource,
  epicsButtonLabel,
  laneStreams,
  orderEpics,
  otherEpicsMode,
  parseEpicsMode,
  searchEpics,
  selectedEpics,
  setDim,
  setEpicNeighbours,
  setEpicRelated,
  toggleEpic,
  withSubEpics
} from './epics-model.js'
import { applyFilters, clearFilters } from './filters.js'
import { change, edge, issue, NOW, shuffled, stream } from './test-fixtures.js'

const R = 'demo-org/engine'

const streams = [
  stream('s10', 'Plan 10', { memberCount: 9 }),
  stream('s2', 'Plan 2', { memberCount: 1 }),
  stream('child-b', 'beta child', { parentId: 's2' }),
  stream('child-a', 'Alpha child', { parentId: 's2', memberCount: 4 }),
  stream('grand', 'Grandchild', { parentId: 'child-a' }),
  stream('orphan', 'Orphan', { parentId: 'gone' }),
  stream('indexer', 'indexer rework', { plan: 'plan:demo/plans/indexer.md' })
]
const names = (rows: { stream: { name: string } }[]) => rows.map((r) => r.stream.name)

describe('orderEpics', () => {
  it('lists each epic under its parent, siblings by name in natural order', () => {
    expect(orderEpics(streams).map((r) => [r.stream.name, r.depth])).toEqual([
      ['indexer rework', 0],
      ['Orphan', 0],
      ['Plan 2', 0],
      ['Alpha child', 1],
      ['Grandchild', 2],
      ['beta child', 1],
      ['Plan 10', 0]
    ])
  })

  it('depends only on names and parents: input order, member counts and selection never move a row', () => {
    const base = names(orderEpics(streams))
    expect(names(orderEpics(shuffled(streams, 3)))).toEqual(base)
    expect(names(orderEpics(streams.map((s, i) => ({ ...s, memberCount: 100 - i * 13 }))))).toEqual(base)
  })

  it('keeps streams caught in a parent cycle', () => {
    const cyc = [stream('x', 'X', { parentId: 'y' }), stream('y', 'Y', { parentId: 'x' })]
    expect(names(orderEpics(cyc)).sort()).toEqual(['X', 'Y'])
  })
})

describe('searchEpics', () => {
  it('keeps matches (every word, any case) with their ancestors, in list order', () => {
    const rows = orderEpics(streams)
    expect(names(searchEpics(rows, 'grand'))).toEqual(['Plan 2', 'Alpha child', 'Grandchild'])
    expect(names(searchEpics(rows, 'PLAN 1'))).toEqual(['Plan 10'])
    expect(names(searchEpics(rows, '  '))).toEqual(names(rows))
    expect(searchEpics(rows, 'nothing-like-it')).toEqual([])
  })
})

describe('selection', () => {
  it('toggles epics in the saved filters, clears them, and ignores ids no longer listed', () => {
    let f = toggleEpic({ dim: true }, 's2')
    f = toggleEpic(f, 'archived-one')
    expect(f).toEqual({ dim: true, workstreams: ['s2', 'archived-one'] })
    expect(selectedEpics(f, streams)).toEqual(['s2'])
    expect(epicsButtonLabel(f, streams)).toBe('Epics (1/7)')
    expect(epicsButtonLabel({}, streams)).toBe('Epics (7)')
    expect(clearEpics(f)).toEqual({ dim: true })
    expect(toggleEpic(toggleEpic({}, 's2'), 's2')).toEqual({})
  })

  it('a selected epic brings its sub-epics', () => {
    expect(withSubEpics(['s2'], streams).sort()).toEqual(['child-a', 'child-b', 'grand', 's2'].sort())
    expect(withSubEpics(['s10'], streams)).toEqual(['s10'])
  })

  it('toggles: neighbours default on, dim', () => {
    expect(setEpicNeighbours({ workstreams: ['s2'] }, false)).toEqual({ workstreams: ['s2'], epicNeighbours: false })
    expect(setEpicNeighbours({ epicNeighbours: false }, true)).toEqual({})
    expect(setDim({}, true)).toEqual({ dim: true })
    expect(setDim({ dim: true, repos: [R] }, false)).toEqual({ repos: [R] })
  })

  it('toggles Owned | Owned + related (default owned), kept by clear filters', () => {
    expect(setEpicRelated({ workstreams: ['s2'] }, true)).toEqual({ workstreams: ['s2'], epicRelated: true })
    expect(setEpicRelated({ epicRelated: true }, false)).toEqual({})
    expect(clearFilters({ epicRelated: true, workstreams: ['s2'], repos: [R] })).toEqual({ epicRelated: true })
  })

  it('counts owned items, and related ones apart', () => {
    expect(epicCounts(stream('x', 'X', { memberCount: 6, relatedCount: 12 }))).toEqual({
      owned: '6',
      related: '12 rel.'
    })
    expect(epicCounts(stream('x', 'X', { memberCount: 6, relatedCount: 0 }))).toEqual({ owned: '6' })
    expect(epicCounts(stream('x', 'X', { memberCount: 0 }))).toEqual({ owned: '0' })
  })
})

describe('epicFocus', () => {
  const a = change(R, 1, { workstreams: ['child-a'] })
  const b = change(R, 2)
  const c = issue(R, 3, { workstreams: ['s10'] })
  const far = issue(R, 4)
  const nodes = [a, b, c, far]
  const edges = [edge(a, b, 'closes'), edge(b, far, 'references')]

  it('is null with nothing selected (or only epics that are gone)', () => {
    expect(epicFocus({}, streams, nodes, edges)).toBeNull()
    expect(epicFocus({ workstreams: ['gone'] }, streams, nodes, edges)).toBeNull()
  })

  it('narrows to the members of the selected epics and sub-epics, with neighbours unless turned off', () => {
    expect([...epicFocus({ workstreams: ['s2'] }, streams, nodes, edges)!].sort()).toEqual([a.id, b.id].sort())
    expect([...epicFocus({ workstreams: ['s2'], epicNeighbours: false }, streams, nodes, edges)!]).toEqual([a.id])
    expect([...epicFocus({ workstreams: ['s2', 's10'] }, streams, nodes, edges)!].sort()).toEqual(
      [a.id, b.id, c.id].sort()
    )
  })

  it('takes the related items in only with Owned + related; neighbours then follow them too', () => {
    const rel = issue(R, 5, { relatedStreams: ['s10'] })
    const relNeighbour = issue(R, 6)
    const all = [...nodes, rel, relNeighbour]
    const es = [...edges, edge(rel, relNeighbour, 'references')]
    expect([...epicFocus({ workstreams: ['s10'] }, streams, all, es)!]).toEqual([c.id])
    expect(
      [...epicFocus({ workstreams: ['s10'], epicRelated: true, epicNeighbours: false }, streams, all, es)!].sort()
    ).toEqual([c.id, rel.id].sort())
    expect([...epicFocus({ workstreams: ['s10'], epicRelated: true }, streams, all, es)!].sort()).toEqual(
      [c.id, rel.id, relNeighbour.id].sort()
    )
    // A sub-epic's related items come with the parent's selection.
    const subRel = issue(R, 7, { relatedStreams: ['grand'] })
    expect(
      epicFocus({ workstreams: ['s2'], epicRelated: true, epicNeighbours: false }, streams, [a, subRel], [])
    ).toEqual(new Set([a.id, subRel.id]))
  })

  it('does not filter on its own: other filters still apply to every node', () => {
    expect(applyFilters(nodes, { workstreams: ['s10'] }, { now: NOW }).visible.size).toBe(4)
  })
})

describe('laneStreams', () => {
  const parent = stream('p', 'Plan 20')
  const child = stream('c', 'Plan 20 PR stack', { parentId: 'p' })
  const other = stream('o', 'Other epic')
  const all = [other, parent, child]
  it('makes lanes of every stream with nothing selected', () => {
    expect(laneStreams({}, all)).toEqual(all)
  })
  it('makes lanes of only the selected epics and their sub-epics', () => {
    expect(laneStreams({ workstreams: ['p'] }, all).map((s) => s.id)).toEqual(['p', 'c'])
  })
})

describe('display', () => {
  it('mode persists as dropdown or modal, one button switches', () => {
    expect(parseEpicsMode('modal')).toBe('modal')
    expect(parseEpicsMode(null)).toBe('dropdown')
    expect(parseEpicsMode('junk')).toBe('dropdown')
    expect(otherEpicsMode('dropdown')).toBe('modal')
    expect(otherEpicsMode('modal')).toBe('dropdown')
  })

  it('names the plan of a plan epic', () => {
    expect(epicSource(streams[6])).toBe('Plan: demo/plans/indexer.md')
    expect(epicSource(streams[0])).toBe('')
  })
})
