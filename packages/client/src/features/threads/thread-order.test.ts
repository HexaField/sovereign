import { describe, it, expect } from 'vitest'
import {
  compareThreads,
  comparePins,
  isListed,
  isPinned,
  isPlaced,
  listedThreads,
  sortThreads
} from './thread-order.js'

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
    const none: { id: string; lastActivity?: number } = { id: 'none' }
    const list = [none, t('some', 1)]
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

describe('manual order (drag to reorder)', () => {
  const o = (id: string, lastActivity: number, sortOrder?: number | null, pinnedAt?: number) => ({
    id,
    lastActivity,
    sortOrder,
    pinnedAt
  })
  const ids = (list: Array<ReturnType<typeof o>>) => sortThreads(list).map((x) => x.id)

  it('placed threads follow their sortOrder, whatever their activity', () => {
    expect(ids([o('a', 99, 2), o('b', 1, 0), o('c', 50, 1)])).toEqual(['b', 'c', 'a'])
  })

  it('threads never placed come first in their group, newest activity first', () => {
    const list = [o('placed-1', 100, 0), o('placed-2', 100, 1), o('new-old', 5), o('new-fresh', 10)]
    expect(ids(list)).toEqual(['new-fresh', 'new-old', 'placed-1', 'placed-2'])
  })

  it('pins stay a top group: unplaced pins (newest pin first), placed pins, then the rest', () => {
    const list = [
      o('rest-placed', 1, 0),
      o('rest-new', 9),
      o('pin-placed-b', 1, 5, 100),
      o('pin-placed-a', 1, 3, 100),
      o('pin-new-old', 1, undefined, 200),
      o('pin-new-late', 1, undefined, 300)
    ]
    expect(ids(list)).toEqual([
      'pin-new-late',
      'pin-new-old',
      'pin-placed-a',
      'pin-placed-b',
      'rest-new',
      'rest-placed'
    ])
  })

  it('a pinned thread with a low sortOrder still sorts below no unpinned thread', () => {
    expect(ids([o('rest', 1, -100), o('pin', 1, 50, 1)])).toEqual(['pin', 'rest'])
  })

  it('treats a null sortOrder (a dropped place) as never placed', () => {
    expect(isPlaced(o('a', 1, null))).toBe(false)
    expect(isPlaced(o('a', 1, 0))).toBe(true)
    expect(ids([o('placed', 9, 0), o('dropped', 1, null)])).toEqual(['dropped', 'placed'])
  })

  it('equal places fall back to activity', () => {
    expect(ids([o('a', 1, 4), o('b', 2, 4)])).toEqual(['b', 'a'])
  })
})

describe('listed threads', () => {
  it('hides the internal presence thread and archived threads, keeps the main presence thread', () => {
    const list = [
      { id: 'main', lastActivity: 1, presence: 'gateway' as const },
      { id: 'internal', lastActivity: 9, presence: 'internal' as const },
      { id: 'gone', lastActivity: 8, archived: true },
      { id: 'work', lastActivity: 5 }
    ]
    expect(listedThreads(list).map((x) => x.id)).toEqual(['work', 'main'])
    expect(isListed(list[0])).toBe(true)
    expect(isListed(list[1])).toBe(false)
    expect(isListed(list[2])).toBe(false)
  })

  it('keeps thread-list order (pins first)', () => {
    const list = [
      { id: 'a', lastActivity: 9 },
      { id: 'b', lastActivity: 1, pinnedAt: 5 }
    ]
    expect(listedThreads(list).map((x) => x.id)).toEqual(['b', 'a'])
  })
})
