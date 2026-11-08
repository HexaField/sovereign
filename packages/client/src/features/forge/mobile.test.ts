import { describe, expect, it } from 'vitest'
import { activeFilterCount, clearFilters } from './filters.js'
import { activeDecisionFilterCount, DEFAULT_DECISION_FILTERS } from './decisions-model.js'
import { isNarrowWidth, NARROW_MAX_PX, panelsToShow, panelStatusParts } from './mobile.js'

describe('isNarrowWidth', () => {
  it('is the phone layout below 640 px, matching Tailwind max-sm', () => {
    expect(NARROW_MAX_PX).toBe(640)
    expect(isNarrowWidth(390)).toBe(true)
    expect(isNarrowWidth(639)).toBe(true)
    expect(isNarrowWidth(640)).toBe(false)
    expect(isNarrowWidth(1280)).toBe(false)
  })
})

describe('panelsToShow', () => {
  it('shows one panel on a phone and every panel on desktop', () => {
    expect(panelsToShow(['a', 'b', 'c'], true)).toEqual(['a'])
    expect(panelsToShow(['a', 'b', 'c'], false)).toEqual(['a', 'b', 'c'])
    expect(panelsToShow([], true)).toEqual([])
  })
})

describe('panelStatusParts', () => {
  it('lists counts and the history window, then only the states that apply', () => {
    expect(panelStatusParts({ visible: 3, total: 9, since: '1/10/2026' })).toEqual([
      '3 / 9 nodes',
      'history from 1/10/2026'
    ])
    const parts = panelStatusParts({
      visible: 1,
      total: 2,
      since: 'x',
      syncing: true,
      syncOff: true,
      lastSyncAt: '2026-10-30T10:00:00Z',
      loading: true
    })
    expect(parts.slice(2, 4)).toEqual(['first sync running…', 'GitHub sync off (forge.enabled)'])
    expect(parts[4]).toMatch(/^synced /)
    expect(parts[5]).toBe('loading…')
  })
})

describe('activeFilterCount', () => {
  it('is 0 for no filters', () => {
    expect(activeFilterCount({})).toBe(0)
  })

  it('counts each picked list value and each toggle', () => {
    expect(
      activeFilterCount({
        repos: ['acme/a', 'acme/b'],
        kinds: ['change'],
        categories: ['bug'],
        labels: ['x'],
        requestedFromMe: true,
        orphans: true,
        agent: 'any',
        updatedWithinDays: 7,
        text: 'fix',
        showPaused: true,
        showEmpty: true,
        dim: true
      })
    ).toBe(13)
  })

  it('ignores blank text, tree picks and status chips (the Tree panel owns those)', () => {
    expect(activeFilterCount({ text: '   ', workstreams: ['task://1'], epicStatus: ['active'] })).toBe(0)
  })

  it('keeps counting the display toggles that Clear keeps', () => {
    const f = { repos: ['acme/a'], dim: true, showPaused: true }
    expect(activeFilterCount(clearFilters(f))).toBe(2)
  })
})

describe('activeDecisionFilterCount', () => {
  it('counts a non-default status, picks and search, not sort or grouping', () => {
    expect(activeDecisionFilterCount(DEFAULT_DECISION_FILTERS)).toBe(0)
    expect(
      activeDecisionFilterCount({
        ...DEFAULT_DECISION_FILTERS,
        status: 'all',
        groups: ['g1', 'g2'],
        threads: ['t'],
        sourceKinds: ['plan'],
        q: 'deploy',
        sort: 'oldest',
        groupBy: 'thread'
      })
    ).toBe(6)
    expect(activeDecisionFilterCount({ ...DEFAULT_DECISION_FILTERS, q: '  ' })).toBe(0)
  })
})
