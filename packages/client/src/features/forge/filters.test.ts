import { describe, it, expect } from 'vitest'
import type { AgentOverlay } from '@sovereign/core'
import {
  agentMatches,
  applyFilters,
  clearFilters,
  filterOptions,
  hasActiveFilters,
  matchesFilters,
  moreActiveCount,
  MORE_MENUS,
  PRIMARY_MENUS,
  stableOptions,
  streamFocus,
  toggleFilterValue
} from './filters.js'
import { NOW, change, edge, issue, iso, merged } from './test-fixtures.js'

const R = 'demo-org/engine'
const R2 = 'demo-org/app'
const ctx = { now: NOW, me: 'hexbot' }

const a = change(R, 1, {
  title: 'Speed up the indexer',
  author: 'alex',
  assignees: ['hexbot'],
  reviewers: [{ login: 'hexbot', state: 'requested' }],
  labels: ['perf'],
  workstreams: ['s1'],
  updatedAt: iso(1),
  branch: { head: 'perf/indexer', base: 'dev' }
})
const b = change(R2, 2, {
  author: 'sam',
  reviewers: [{ login: 'robin', state: 'approved' }],
  labels: ['ui'],
  updatedAt: iso(10)
})
const c = merged(R, 3, 4, { author: 'alex' })
const d = issue(R, 4, { labels: ['bug', 'perf'] })
const all = [a, b, c, d]

describe('matchesFilters', () => {
  it('no filters matches everything', () => {
    expect(all.every((n) => matchesFilters(n, {}, ctx))).toBe(true)
  })

  it('ORs values within a filter and ANDs filters together', () => {
    const ids = (f: Parameters<typeof matchesFilters>[1]) =>
      all.filter((n) => matchesFilters(n, f, ctx)).map((n) => n.number)
    expect(ids({ repos: [R] })).toEqual([1, 3, 4])
    expect(ids({ repos: [R, R2] })).toEqual([1, 2, 3, 4])
    expect(ids({ repos: [R], authors: ['alex'] })).toEqual([1, 3])
    expect(ids({ states: ['merged'] })).toEqual([3])
    expect(ids({ kinds: ['issue'] })).toEqual([4])
    expect(ids({ kinds: ['change'] })).toEqual([1, 2, 3])
    expect(ids({ kinds: ['change'], states: ['merged'] })).toEqual([3])
    expect(ids({ zones: ['future'] })).toEqual([4])
    expect(ids({ labels: ['perf'] })).toEqual([1, 4])
    expect(ids({ assignees: ['hexbot'] })).toEqual([1])
    expect(ids({ reviewers: ['robin'] })).toEqual([2])
    // Epics focus the canvas (epics-model.ts); they are not a filter.
    expect(ids({ workstreams: ['s1'] })).toEqual([1, 2, 3, 4])
    expect(ids({ updatedWithinDays: 7 })).toEqual([1, 3, 4])
  })

  it('requestedFromMe matches a pending review request for the forge identity only', () => {
    expect(all.filter((n) => matchesFilters(n, { requestedFromMe: true }, ctx)).map((n) => n.number)).toEqual([1])
    // Without an identity nothing can be "mine".
    expect(all.filter((n) => matchesFilters(n, { requestedFromMe: true }, { now: NOW })).length).toBe(0)
    // An approved review by me is not a request.
    const done = change(R, 9, { reviewers: [{ login: 'hexbot', state: 'approved' }] })
    expect(matchesFilters(done, { requestedFromMe: true }, ctx)).toBe(false)
  })

  it('text matches title, #number, branch, labels and author, every word', () => {
    expect(matchesFilters(a, { text: 'indexer' }, ctx)).toBe(true)
    expect(matchesFilters(a, { text: '#1' }, ctx)).toBe(true)
    expect(matchesFilters(a, { text: 'perf/indexer' }, ctx)).toBe(true)
    expect(matchesFilters(a, { text: 'SPEED alex' }, ctx)).toBe(true)
    expect(matchesFilters(a, { text: 'speed robin' }, ctx)).toBe(false)
  })

  it('agent filter reads the overlay', () => {
    const working: AgentOverlay = { nodeId: a.id, thread: { id: 't', label: 'T', status: 'working' }, subagents: [] }
    const ci: AgentOverlay = { nodeId: a.id, subagents: [], ciWatch: { state: 'waiting', since: 0 } }
    const review: AgentOverlay = { nodeId: a.id, subagents: [], waitingOn: 'review' }
    expect(agentMatches('any', working)).toBe(true)
    expect(agentMatches('any', { nodeId: a.id, subagents: [] })).toBe(false)
    expect(agentMatches('any', undefined)).toBe(false)
    expect(agentMatches('waiting-ci', ci)).toBe(true)
    expect(agentMatches('waiting-ci', working)).toBe(false)
    expect(agentMatches('waiting-review', review)).toBe(true)
    expect(agentMatches(undefined, undefined)).toBe(true)
    const overlays = new Map([[a.id, working]])
    expect(all.filter((n) => matchesFilters(n, { agent: 'any' }, { ...ctx, overlays })).map((n) => n.number)).toEqual([
      1
    ])
  })
})

describe('applyFilters', () => {
  it('hides non-matching nodes by default', () => {
    const r = applyFilters(all, { repos: [R2] }, ctx)
    expect([...r.visible]).toEqual([b.id])
    expect(r.dimmed.size).toBe(0)
  })

  it('dims instead of hiding in dim mode', () => {
    const r = applyFilters(all, { repos: [R2], dim: true }, ctx)
    expect(r.visible.size).toBe(4)
    expect([...r.dimmed].sort()).toEqual([a.id, c.id, d.id].sort())
    expect([...r.matched]).toEqual([b.id])
  })
})

describe('filter editing', () => {
  it('toggles list values and drops emptied lists', () => {
    let f = toggleFilterValue({}, 'repos', R)
    expect(f).toEqual({ repos: [R] })
    f = toggleFilterValue(f, 'repos', R2)
    expect(f.repos).toEqual([R, R2])
    f = toggleFilterValue(toggleFilterValue(f, 'repos', R), 'repos', R2)
    expect(f).toEqual({})
  })

  it('hasActiveFilters ignores dim alone; clear keeps dim', () => {
    expect(hasActiveFilters({ dim: true })).toBe(false)
    expect(hasActiveFilters({ text: '  ' })).toBe(false)
    expect(hasActiveFilters({ requestedFromMe: true })).toBe(true)
    expect(clearFilters({ repos: [R], dim: true })).toEqual({ dim: true })
    expect(clearFilters({ repos: [R] })).toEqual({})
    // The epic selection goes; the neighbours preference stays.
    expect(clearFilters({ workstreams: ['s1'], epicNeighbours: false })).toEqual({ epicNeighbours: false })
  })

  it('lists options with counts', () => {
    const o = filterOptions(all)
    expect(o.repos).toEqual([
      { value: R, label: R, count: 3 },
      { value: R2, label: R2, count: 1 }
    ])
    expect(o).not.toHaveProperty('workstreams')
    expect(o.zones.map((z) => z.value)).toEqual(['past', 'present', 'future'])
    expect(o.labels[0]).toEqual({ value: 'perf', label: 'perf', count: 2 })
    // The Type menu: PRs first, then issues, with plural labels
    expect(o.kinds).toEqual([
      { value: 'change', label: 'PRs', count: 3 },
      { value: 'issue', label: 'Issues', count: 1 }
    ])
    expect(hasActiveFilters({ kinds: ['issue'] })).toBe(true)
  })
})

describe('stableOptions', () => {
  const values = (o: { value: string }[]) => o.map((x) => x.value)

  it('keeps the first order while picks reload a narrower window, and keeps filtered-out values', () => {
    const first = stableOptions(undefined, filterOptions(all), {})
    expect(values(first.labels)).toEqual(['perf', 'bug', 'ui'])
    // The user picks "ui"; the server then serves only b, where "ui" is the only label.
    const picked = { labels: ['ui'] }
    const next = stableOptions(first, filterOptions([b]), picked)
    expect(values(next.labels)).toEqual(['perf', 'bug', 'ui'])
    expect(next.labels.map((x) => x.count)).toEqual([0, 0, 1])
    // A later load where "bug" outnumbers "perf" still does not move anything.
    const busy = [d, issue(R, 5, { labels: ['bug'] }), issue(R, 6, { labels: ['bug'] })]
    expect(values(stableOptions(next, filterOptions(busy), picked).labels)).toEqual(['perf', 'bug', 'ui'])
  })

  it('appends values new to the panel, and a selected value it never saw', () => {
    const first = stableOptions(undefined, filterOptions([a]), {})
    const next = stableOptions(first, filterOptions(all), { authors: ['robin-ghost'] })
    expect(values(next.repos)).toEqual([R, R2])
    expect(values(next.authors)).toEqual(['alex', 'sam', 'robin-ghost'])
    expect(next.authors[2].count).toBe(0)
  })

  it('splits the chips: Repo, Type, State, Assignee shown; Zone, Author, Reviewer, Label behind More', () => {
    expect(PRIMARY_MENUS.map((m) => m.label)).toEqual(['Repo', 'Type', 'State', 'Assignee'])
    expect(MORE_MENUS.map((m) => m.label)).toEqual(['Zone', 'Author', 'Reviewer', 'Label'])
    expect(moreActiveCount({ repos: [R], labels: ['ui', 'perf'], zones: ['past'] })).toBe(3)
    expect(moreActiveCount({ repos: [R] })).toBe(0)
  })
})

describe('streamFocus', () => {
  it('is the members plus their direct neighbours, nothing further', () => {
    const far = issue(R, 50)
    const edges = [edge(a, d, 'closes'), edge(b, a, 'references'), edge(d, far, 'references')]
    const s = streamFocus('s1', [...all, far], edges)
    expect([...s].sort()).toEqual([a.id, b.id, d.id].sort())
  })

  it('includes the stream task node itself', () => {
    const st = { ...issue(R, 0), id: 'task:s1', kind: 'task' as const, taskId: 's1' }
    expect(streamFocus('s1', [st], []).has('task:s1')).toBe(true)
  })

  it('takes several streams, and leaves the neighbours out on request', () => {
    const e = { ...b, id: 'b2', workstreams: ['s2'] }
    const edges = [edge(a, d, 'closes')]
    expect([...streamFocus(['s1', 's2'], [...all, e], edges)].sort()).toEqual([a.id, d.id, 'b2'].sort())
    expect([...streamFocus(['s1', 's2'], [...all, e], edges, false)].sort()).toEqual([a.id, 'b2'].sort())
  })
})
