import { describe, it, expect } from 'vitest'
import { compareThreads, comparePins, isPinned, sortThreads } from './thread-order.js'

const t = (id: string, lastActivity: number, pinnedAt?: number | null) => ({ id, lastActivity, pinnedAt })

describe('thread order', () => {
  it('without pins, orders by last activity, newest first', () => {
    const list = [t('a', 1), t('b', 3), t('c', 2)]
    expect(sortThreads(list).map((x) => x.id)).toEqual(['b', 'c', 'a'])
  })

  it('puts pinned threads first, most recently pinned first, then the rest by activity', () => {
    const list = [t('old', 1), t('busy', 50), t('pinned-early', 2, 100), t('pinned-late', 3, 200), t('mid', 10)]
    expect(sortThreads(list).map((x) => x.id)).toEqual(['pinned-late', 'pinned-early', 'busy', 'mid', 'old'])
  })

  it('keeps pins in pin order whatever their activity', () => {
    const list = [t('a', 999, 100), t('b', 1, 200)]
    expect(sortThreads(list).map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('treats a null or missing pinnedAt (an unpin) as unpinned', () => {
    expect(isPinned(t('a', 1, null))).toBe(false)
    expect(isPinned(t('a', 1))).toBe(false)
    expect(isPinned(t('a', 1, 5))).toBe(true)
    const list = [t('unpinned', 5, null), t('pinned', 1, 7)]
    expect(sortThreads(list).map((x) => x.id)).toEqual(['pinned', 'unpinned'])
  })

  it('handles a missing lastActivity', () => {
    const list = [{ id: 'none' }, t('some', 1)]
    expect(sortThreads(list).map((x) => x.id)).toEqual(['some', 'none'])
  })

  it('returns a copy and leaves the input alone', () => {
    const list = [t('a', 1), t('b', 2)]
    const sorted = sortThreads(list)
    expect(sorted).not.toBe(list)
    expect(list.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('comparePins is 0 between two unpinned threads, so a list can apply its own order', () => {
    expect(comparePins(t('a', 1), t('b', 2))).toBe(0)
    expect(comparePins(t('a', 1, 5), t('b', 2))).toBeLessThan(0)
    expect(compareThreads(t('a', 1), t('b', 2))).toBeGreaterThan(0)
  })
})
