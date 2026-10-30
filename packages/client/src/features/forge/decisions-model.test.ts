import type { Decision } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import {
  ageLabel,
  DEFAULT_DECISION_FILTERS,
  decisionFilterOptions,
  deliverySummary,
  filterDecisions,
  groupDecisionsBy,
  knownGroups,
  NONE,
  openCount,
  parseDecisionFilters,
  resolvePayload,
  sortDecisions,
  sourceTarget,
  toggleSection,
  type DecisionFilters
} from './decisions-model.js'

const d = (n: number, over: Partial<Decision> = {}): Decision => ({
  id: `forge-decision://demo/${n}`,
  membrane: 'demo',
  question: `Question ${n}?`,
  status: 'open',
  createdAt: `2026-10-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`,
  ...over
})

const NAMES: Record<string, string> = { 'thread-a': 'Indexer', 'thread-b': 'Release' }
const name = (id: string) => NAMES[id]

const LIST: Decision[] = [
  d(1, {
    group: 'Index',
    threadId: 'thread-a',
    source: { kind: 'plan', ref: 'plan:engine/plans/index.md', label: 'Index plan' }
  }),
  d(2, { group: 'release', threadId: 'thread-b', options: ['Friday', 'Monday'] }),
  d(3, { threadId: 'thread-a', source: { kind: 'thread', ref: 'thread-a' }, context: 'Mentions **SQLite**' }),
  d(4, { status: 'resolved', resolution: 'Yes', group: 'Index' }),
  d(5, { source: { kind: 'other', ref: 'standup' } })
]
const f = (over: Partial<DecisionFilters> = {}): DecisionFilters => ({ ...DEFAULT_DECISION_FILTERS, ...over })
const ids = (list: Decision[]) => list.map((x) => Number(x.id.split('/').pop()))

describe('decisions model', () => {
  it('parses saved filters, falling back to open / newest / no grouping', () => {
    expect(parseDecisionFilters(null)).toEqual(DEFAULT_DECISION_FILTERS)
    expect(parseDecisionFilters('not json')).toEqual(DEFAULT_DECISION_FILTERS)
    expect(
      parseDecisionFilters(
        JSON.stringify({
          status: 'all',
          groups: ['Index', 3],
          sourceKinds: ['plan', 'chat'],
          sort: 'thread',
          groupBy: 'x',
          q: 'db'
        })
      )
    ).toEqual({
      ...DEFAULT_DECISION_FILTERS,
      status: 'all',
      groups: ['Index'],
      sourceKinds: ['plan'],
      sort: 'thread',
      q: 'db'
    })
  })

  it('filters by status, group, thread, source kind and text', () => {
    expect(ids(filterDecisions(LIST, f()))).toEqual([1, 2, 3, 5])
    expect(ids(filterDecisions(LIST, f({ status: 'resolved' })))).toEqual([4])
    expect(ids(filterDecisions(LIST, f({ status: 'all', groups: ['Index'] })))).toEqual([1, 4])
    expect(ids(filterDecisions(LIST, f({ groups: [NONE] })))).toEqual([3, 5])
    expect(ids(filterDecisions(LIST, f({ threads: ['thread-a', NONE] })))).toEqual([1, 3, 5])
    expect(ids(filterDecisions(LIST, f({ sourceKinds: ['plan', 'none'] })))).toEqual([1, 2])
    expect(ids(filterDecisions(LIST, f({ q: 'sqlite' })))).toEqual([3])
    expect(ids(filterDecisions(LIST, f({ q: 'monday' })))).toEqual([2])
    expect(ids(filterDecisions(LIST, f({ q: 'release' }), name))).toEqual([2])
    expect(ids(filterDecisions(LIST, f({ q: 'indexer' }), name))).toEqual([1, 3])
  })

  it('sorts newest, oldest, by group, thread name and source; unnamed last, newest first within a key', () => {
    expect(ids(sortDecisions(LIST, 'newest'))).toEqual([5, 4, 3, 2, 1])
    expect(ids(sortDecisions(LIST, 'oldest'))).toEqual([1, 2, 3, 4, 5])
    expect(ids(sortDecisions(LIST, 'group'))).toEqual([4, 1, 2, 5, 3])
    expect(ids(sortDecisions(LIST, 'thread', name))).toEqual([3, 1, 2, 5, 4])
    expect(ids(sortDecisions(LIST, 'source'))).toEqual([5, 1, 3, 4, 2])
  })

  it('groups by group or thread into labelled sections, named first', () => {
    const open = filterDecisions(LIST, f())
    expect(groupDecisionsBy(open, 'none')).toEqual([{ key: 'all', label: 'All', items: open }])
    expect(groupDecisionsBy([], 'none')).toEqual([])
    expect(groupDecisionsBy(open, 'group').map((s) => [s.key, s.label, ids(s.items)])).toEqual([
      ['Index', 'Index', [1]],
      ['release', 'release', [2]],
      [NONE, 'No group', [3, 5]]
    ])
    expect(groupDecisionsBy(open, 'thread', name).map((s) => [s.key, s.label, ids(s.items)])).toEqual([
      ['thread-a', 'Indexer', [1, 3]],
      ['thread-b', 'Release', [2]],
      [NONE, 'No thread', [5]]
    ])
  })

  it('offers filter choices with counts for the status shown, and the known groups', () => {
    const o = decisionFilterOptions(LIST, 'open', name)
    expect(o.groups).toEqual([
      { value: 'Index', label: 'Index', count: 1 },
      { value: 'release', label: 'release', count: 1 },
      { value: NONE, label: 'No group', count: 2 }
    ])
    expect(o.threads.map((t) => [t.label, t.count])).toEqual([
      ['Indexer', 2],
      ['Release', 1],
      ['No thread', 1]
    ])
    expect(o.sourceKinds.map((s) => [s.value, s.count])).toEqual([
      ['other', 1],
      ['plan', 1],
      ['thread', 1],
      ['none', 1]
    ])
    expect(knownGroups(LIST)).toEqual(['Index', 'release'])
    expect(openCount(LIST)).toBe(4)
  })

  it('selects a whole section, and clears it when all are selected', () => {
    const one = toggleSection(new Set(['x']), ['a', 'b'])
    expect([...one].sort()).toEqual(['a', 'b', 'x'])
    expect([...toggleSection(one, ['a', 'b'])]).toEqual(['x'])
    expect([...toggleSection(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b'])
  })

  it('builds the resolve payload in order, skipping resolved ones and naming those without a resolution', () => {
    const picked = [LIST[2], LIST[0], LIST[3], LIST[1]]
    const { body, missing } = resolvePayload('demo', picked, {
      [LIST[2].id]: '  SQLite  ',
      [LIST[0].id]: 'Postgres',
      [LIST[1].id]: '   '
    })
    expect(body).toEqual({
      membrane: 'demo',
      items: [
        { id: LIST[2].id, resolution: 'SQLite' },
        { id: LIST[0].id, resolution: 'Postgres' }
      ]
    })
    expect(missing.map((x) => x.id)).toEqual([LIST[1].id])
  })

  it('sums up what went to which thread', () => {
    const resolved = [
      d(1, { threadId: 'thread-a' }),
      d(3, { threadId: 'thread-a' }),
      d(2, { threadId: 'thread-x' }),
      d(5)
    ]
    expect(
      deliverySummary(
        {
          resolved,
          deliveries: [
            { threadId: 'thread-a', ids: ['1', '3'], sent: true },
            { threadId: 'thread-x', ids: ['2'], sent: false, error: 'thread is gone' }
          ]
        },
        name
      )
    ).toBe(
      'Resolved 4 decisions. Sent 1 message: Indexer (2 decisions). Could not reach thread-x: thread is gone. 1 decision had no thread.'
    )
    expect(deliverySummary({ resolved: [d(5)], deliveries: [] })).toBe(
      'Resolved 1 decision. No messages sent. 1 decision had no thread.'
    )
  })

  it('labels ages and resolves source links', () => {
    const now = Date.parse('2026-10-30T12:00:00Z')
    expect(ageLabel('2026-10-30T11:59:40Z', now)).toBe('just now')
    expect(ageLabel('2026-10-30T11:15:00Z', now)).toBe('45m')
    expect(ageLabel('2026-10-30T02:00:00Z', now)).toBe('10h')
    expect(ageLabel('2026-10-27T12:00:00Z', now)).toBe('3d')
    expect(ageLabel('2026-09-01T12:00:00Z', now)).toBe('8w')
    expect(sourceTarget(undefined)).toEqual({ kind: 'none' })
    expect(sourceTarget({ kind: 'thread', ref: 'thread-a' })).toEqual({ kind: 'thread', id: 'thread-a' })
    expect(sourceTarget({ kind: 'node', ref: 'github:github.com/o/r#1' })).toEqual({
      kind: 'node',
      id: 'github:github.com/o/r#1'
    })
    expect(sourceTarget({ kind: 'plan', ref: 'plan:engine/plans/a.md' })).toEqual({
      kind: 'node',
      id: 'plan:engine/plans/a.md'
    })
    expect(sourceTarget({ kind: 'plan', ref: 'engine/plans/a.md' })).toEqual({
      kind: 'node',
      id: 'plan:engine/plans/a.md'
    })
    expect(sourceTarget({ kind: 'plan', ref: '/srv/plans/a.md' })).toEqual({ kind: 'file', path: '/srv/plans/a.md' })
    expect(sourceTarget({ kind: 'other', ref: 'standup' })).toEqual({ kind: 'none' })
  })
})
