import { describe, expect, it } from 'vitest'
import {
  clearEpics,
  epicFocus,
  epicSource,
  focusedEpics,
  laneStreams,
  orderEpics,
  otherEpicsMode,
  panelShown,
  panelVisibility,
  parseEpicsMode,
  pickedEpics,
  searchEpics,
  selectedEpics,
  setDim,
  setEpicNeighbours,
  setEpicRelated,
  shownEpics,
  shownStatuses,
  toggleEpic,
  toggleEpicStatus,
  wantsArchived,
  withSubEpics
} from './epics-model.js'
import { applyFilters, clearFilters, hasActiveFilters } from './filters.js'
import { change, edge, issue, NOW, shuffled, stream } from './test-fixtures.js'
import { treeButtonLabel } from './tree-model.js'

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
    expect(treeButtonLabel(f, streams)).toBe('Tree (1/7)')
    expect(treeButtonLabel({}, streams)).toBe('Tree (7)')
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

  it('is null while "Not in a tree" is on: orphans sit outside every node', () => {
    expect(epicFocus({ workstreams: ['s2'], orphans: true }, streams, nodes, edges)).toBeNull()
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

describe('status chips', () => {
  const act1 = stream('act1', 'Identity', { status: 'active' })
  const actSub = stream('act-sub', 'Identity follow-ups', { parentId: 'act1', status: 'paused' })
  const act2 = stream('act2', 'Indexer', { status: 'active' })
  const planned = stream('pl', 'Someday', { status: 'planned' })
  const paused = stream('pa', 'AI assistant', { status: 'paused' })
  const gone = stream('ar', 'Old', { status: 'archived' })
  const all = [act1, actSub, act2, planned, paused, gone]
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

  it('lists every status but archived with none chosen, else the chosen ones', () => {
    expect(shownStatuses({})).toEqual(['active', 'planned', 'paused'])
    expect(ids(shownEpics({}, all))).toEqual(['act1', 'act-sub', 'act2', 'pl', 'pa'])
    expect(ids(shownEpics({ epicStatus: ['archived'] }, all))).toEqual(['ar'])
    expect(ids(shownEpics({ epicStatus: ['paused', 'active'] }, all))).toEqual(['act1', 'act-sub', 'act2', 'pa'])
  })

  it('selects every epic of the chosen statuses while none is picked; picks win, within the shown statuses', () => {
    expect(selectedEpics({}, all)).toEqual([])
    expect(selectedEpics({ epicStatus: ['active'] }, all)).toEqual(['act1', 'act2'])
    expect(selectedEpics({ epicStatus: ['active'], workstreams: ['act2'] }, all)).toEqual(['act2'])
    expect(pickedEpics({ epicStatus: ['active'], workstreams: ['act2'] }, all)).toEqual(['act2'])
    // A pick of a status not shown drops out; with no pick left, the status selects.
    expect(selectedEpics({ epicStatus: ['active'], workstreams: ['pa'] }, all)).toEqual(['act1', 'act2'])
    expect(selectedEpics({ workstreams: ['ar', 'pa'] }, all)).toEqual(['pa'])
    // Sub-epics join only when their status is shown.
    expect(focusedEpics({ epicStatus: ['active'] }, all)).toEqual(['act1', 'act2'])
    expect(focusedEpics({ epicStatus: ['active', 'paused'], workstreams: ['act1'] }, all).sort()).toEqual(
      ['act-sub', 'act1'].sort()
    )
  })

  it('canvas focus, lanes and Kanban all follow a status selection', () => {
    const inIdentity = change(R, 1, { workstreams: ['act1'] })
    const inIndexer = issue(R, 2, { workstreams: ['act2'] })
    const inAssistant = change(R, 3, { workstreams: ['pa'] })
    const loose = issue(R, 4)
    const nodes = [inIdentity, inIndexer, inAssistant, loose]
    const f = { epicStatus: ['active' as const], epicNeighbours: false }
    const focus = epicFocus(f, all, nodes, [])
    expect(focus).toEqual(new Set([inIdentity.id, inIndexer.id]))
    expect(ids(laneStreams(f, all))).toEqual(['act1', 'act2'])
    // The Kanban lists panelShown(panelVisibility(…)), the same sets the canvas draws.
    const filtered = applyFilters(nodes, f, { now: NOW })
    expect(panelShown(panelVisibility(filtered, focus, false))).toEqual(new Set([inIdentity.id, inIndexer.id]))
    const dimmed = panelVisibility(filtered, focus, true)
    expect(dimmed.visible.size).toBe(4)
    expect(panelShown(dimmed)).toEqual(new Set([inIdentity.id, inIndexer.id]))
    // Picking one active epic narrows it to that epic.
    expect(epicFocus({ ...f, workstreams: ['act2'] }, all, nodes, [])).toEqual(new Set([inIndexer.id]))
    // No status, no pick: no focus; lanes for every non-archived epic.
    expect(epicFocus({}, all, nodes, [])).toBeNull()
    expect(ids(laneStreams({}, all))).toEqual(['act1', 'act-sub', 'act2', 'pl', 'pa'])
  })

  it('toggles chips, clears them with the picks, labels the button and asks for archived epics', () => {
    let f = toggleEpicStatus({}, 'active')
    f = toggleEpicStatus(f, 'paused')
    expect(f).toEqual({ epicStatus: ['active', 'paused'] })
    expect(toggleEpicStatus(f, 'active')).toEqual({ epicStatus: ['paused'] })
    expect(toggleEpicStatus({ epicStatus: ['active'] }, 'active')).toEqual({})
    expect(treeButtonLabel(f, all)).toBe('Tree: Active, Paused (4)')
    expect(treeButtonLabel({ ...f, workstreams: ['act1'] }, all)).toBe('Tree (1/4)')
    expect(treeButtonLabel({}, all)).toBe('Tree (5)')
    expect(clearEpics({ ...f, workstreams: ['act1'], dim: true })).toEqual({ dim: true })
    expect(hasActiveFilters({ epicStatus: ['planned'] })).toBe(true)
    expect(wantsArchived(f)).toBe(false)
    expect(wantsArchived({ epicStatus: ['archived'] })).toBe(true)
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
