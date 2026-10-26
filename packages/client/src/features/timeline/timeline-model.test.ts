import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '@sovereign/core'
import {
  DEFAULT_FILTERS,
  KIND_META,
  entryTarget,
  formatAbsolute,
  formatRelative,
  groupByDay,
  insertLive,
  appendOlder,
  matchesFilters,
  originGroup,
  parseFilters,
  queryOf,
  toggle
} from './timeline-model.js'

// Local-time anchors: the panel groups and labels days in the viewer's zone.
const NOW = new Date(2026, 9, 26, 15, 0, 0).getTime()
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString()
let n = 0
const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: `t${(n++).toString(36)}-x`,
  at: at(26, 14),
  kind: 'agent',
  action: 'turn.started',
  title: 'Widget work: turn started',
  ...over
})

describe('formatting', () => {
  it('relative time, coarse', () => {
    expect(formatRelative(new Date(NOW - 20_000).toISOString(), NOW)).toBe('now')
    expect(formatRelative(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m')
    expect(formatRelative(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3h')
    expect(formatRelative(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('2d')
    // A clock a little ahead of the server's never shows negative time.
    expect(formatRelative(new Date(NOW + 5000).toISOString(), NOW)).toBe('now')
  })

  it('absolute time for the hover title', () => {
    expect(formatAbsolute(at(26, 9, 5))).toMatch(/2026/)
    expect(formatAbsolute(at(26, 9, 5))).toMatch(/09:05|9:05/)
  })

  it('every kind has an icon, a colour token and a label', () => {
    for (const k of ['forge', 'github', 'agent', 'subagent', 'scheduler', 'system'] as const) {
      expect(KIND_META[k].icon).toBeTruthy()
      expect(KIND_META[k].color).toMatch(/^var\(--c-/)
      expect(KIND_META[k].label).toBeTruthy()
    }
  })

  it('a thread opens the thread; otherwise a url opens in a new tab; else nothing', () => {
    expect(entryTarget(entry({ threadId: 't1', url: 'https://github.com/x' }))).toEqual({
      kind: 'thread',
      threadId: 't1'
    })
    expect(entryTarget(entry({ url: 'https://github.com/acme-labs/widget/pull/12' }))).toEqual({
      kind: 'url',
      url: 'https://github.com/acme-labs/widget/pull/12'
    })
    expect(entryTarget(entry({ url: 'javascript:alert(1)' }))).toBeNull()
    expect(entryTarget(entry())).toBeNull()
  })
})

describe('filters', () => {
  it('origins fold into user / automated / subagent', () => {
    expect(originGroup('user')).toBe('user')
    expect((['cron', 'rethink', 'agent', 'system', undefined] as const).map((o) => originGroup(o))).toEqual([
      'automated',
      'automated',
      'automated',
      'automated',
      'automated'
    ])
    expect(originGroup('subagent')).toBe('subagent')
  })

  it('an entry shows when its kind and its origin group are both on', () => {
    const f = { kinds: ['agent' as const], origins: ['user' as const] }
    expect(matchesFilters(entry({ origin: 'user' }), f)).toBe(true)
    expect(matchesFilters(entry({ origin: 'cron' }), f)).toBe(false)
    expect(matchesFilters(entry({ kind: 'forge', origin: 'user' }), f)).toBe(false)
    expect(matchesFilters(entry({ kind: 'forge', origin: 'system' }), DEFAULT_FILTERS)).toBe(true)
  })

  it('toggling a chip; the last one on stays on', () => {
    expect(toggle(['agent', 'forge'], 'forge')).toEqual(['agent'])
    expect(toggle(['agent'], 'forge')).toEqual(['agent', 'forge'])
    expect(toggle(['agent'], 'agent')).toEqual(['agent'])
  })

  it('reads stored filters defensively', () => {
    expect(parseFilters(null)).toEqual(DEFAULT_FILTERS)
    expect(parseFilters('{nope')).toEqual(DEFAULT_FILTERS)
    expect(parseFilters(JSON.stringify({ kinds: ['forge', 'bogus'], origins: ['user'] }))).toEqual({
      kinds: ['forge'],
      origins: ['user']
    })
    expect(parseFilters(JSON.stringify({ kinds: [], origins: [] }))).toEqual(DEFAULT_FILTERS)
  })

  it('the server query carries what the chips narrow, and nothing when all are on', () => {
    expect(queryOf(DEFAULT_FILTERS)).toEqual({})
    expect(queryOf({ kinds: ['forge', 'github'], origins: ['user', 'automated', 'subagent'] })).toEqual({
      kinds: 'forge,github'
    })
    expect(queryOf({ kinds: DEFAULT_FILTERS.kinds, origins: ['user', 'subagent'] })).toEqual({
      origins: 'user,subagent'
    })
    expect(queryOf({ kinds: DEFAULT_FILTERS.kinds, origins: ['automated'] })).toEqual({
      origins: 'cron,rethink,agent,system'
    })
  })
})

describe('grouping and live updates', () => {
  it('groups newest first by local day: Today, Yesterday, then dates', () => {
    const list = [
      entry({ at: at(26, 14) }),
      entry({ at: at(26, 9) }),
      entry({ at: at(25, 22) }),
      entry({ at: at(20, 8) })
    ]
    const groups = groupByDay(list, NOW)
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
      [expect.stringMatching(/20/), 1]
    ])
  })

  it('a live entry goes on top, once', () => {
    const a = entry({ at: at(26, 10) })
    const b = entry({ at: at(26, 11) })
    let list = [a]
    list = insertLive(list, b)
    expect(list.map((e) => e.id)).toEqual([b.id, a.id])
    expect(insertLive(list, b)).toBe(list)
    // One that arrives late still sorts by time.
    const late = entry({ at: at(26, 10, 30) })
    expect(insertLive(list, late).map((e) => e.id)).toEqual([b.id, late.id, a.id])
  })

  it('an older page appends below, skipping what is already there', () => {
    const a = entry({ at: at(26, 11) })
    const b = entry({ at: at(26, 10) })
    const c = entry({ at: at(26, 9) })
    expect(appendOlder([a, b], [b, c]).map((e) => e.id)).toEqual([a.id, b.id, c.id])
  })
})
