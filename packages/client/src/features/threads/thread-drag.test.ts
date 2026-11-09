import { describe, it, expect } from 'vitest'
import {
  applyReorder,
  assignSortOrders,
  autoScrollStep,
  dropIndexAt,
  planDrop,
  restoreOrder,
  snapshotOrder,
  type DragThread
} from './thread-drag.js'
import { sortThreads } from './thread-order.js'

const t = (id: string, pinnedAt?: number, sortOrder?: number): DragThread => ({
  id,
  pinnedAt,
  sortOrder,
  lastActivity: 1
})
const ids = (list: DragThread[]) => list.map((x) => x.id)

describe('dropIndexAt', () => {
  const rows = [
    { top: 0, bottom: 20 },
    { top: 20, bottom: 40 },
    { top: 40, bottom: 60 }
  ]

  it('drops before the first row whose middle is below the pointer', () => {
    expect(dropIndexAt(rows, -5)).toBe(0)
    expect(dropIndexAt(rows, 9)).toBe(0)
    expect(dropIndexAt(rows, 11)).toBe(1)
    expect(dropIndexAt(rows, 35)).toBe(2)
  })

  it('drops after the last row below its middle', () => {
    expect(dropIndexAt(rows, 55)).toBe(3)
    expect(dropIndexAt(rows, 500)).toBe(3)
  })

  it('handles an empty list', () => {
    expect(dropIndexAt([], 10)).toBe(0)
  })
})

describe('planDrop', () => {
  const plain = [t('a'), t('b'), t('c'), t('d')]

  it('moves a thread down: the group in its new order', () => {
    // Insertion index 3 = between c and d.
    expect(planDrop(plain, 'a', 3)).toEqual({ ids: ['b', 'c', 'a', 'd'] })
    expect(planDrop(plain, 'a', 4)).toEqual({ ids: ['b', 'c', 'd', 'a'] })
  })

  it('moves a thread up', () => {
    expect(planDrop(plain, 'd', 0)).toEqual({ ids: ['d', 'a', 'b', 'c'] })
    expect(planDrop(plain, 'c', 1)).toEqual({ ids: ['a', 'c', 'b', 'd'] })
  })

  it('is null where nothing changes: its own place, either side', () => {
    expect(planDrop(plain, 'b', 1)).toBeNull()
    expect(planDrop(plain, 'b', 2)).toBeNull()
  })

  it('is null for an unknown thread or a one-thread list', () => {
    expect(planDrop(plain, 'zz', 0)).toBeNull()
    expect(planDrop([t('a')], 'a', 1)).toBeNull()
  })

  describe('across the pinned line', () => {
    const list = [t('p1', 100), t('p2', 50), t('u1'), t('u2')]

    it('within the pinned group reorders only the pins', () => {
      expect(planDrop(list, 'p2', 0)).toEqual({ ids: ['p2', 'p1'] })
    })

    it('within the unpinned group reorders only the rest', () => {
      expect(planDrop(list, 'u2', 2)).toEqual({ ids: ['u2', 'u1'] })
    })

    it('dropped among the pins (or above them) pins the thread', () => {
      expect(planDrop(list, 'u2', 1)).toEqual({ ids: ['p1', 'u2', 'p2'], pinned: true })
      expect(planDrop(list, 'u1', 0)).toEqual({ ids: ['u1', 'p1', 'p2'], pinned: true })
    })

    it('dropped among the rest (or below them) unpins the thread', () => {
      expect(planDrop(list, 'p1', 3)).toEqual({ ids: ['u1', 'p1', 'u2'], pinned: false })
      expect(planDrop(list, 'p2', 4)).toEqual({ ids: ['u1', 'u2', 'p2'], pinned: false })
    })

    it('right on the line, a thread stays in its own group', () => {
      // Insertion index 2 = between p2 and u1.
      expect(planDrop(list, 'p1', 2)).toEqual({ ids: ['p2', 'p1'] })
      expect(planDrop(list, 'u2', 2)).toEqual({ ids: ['u2', 'u1'] })
    })

    it('never pins or unpins a thread dropped back where it was', () => {
      expect(planDrop([t('p', 1), t('u')], 'u', 2)).toBeNull()
      expect(planDrop([t('p', 1), t('u')], 'p', 0)).toBeNull()
    })

    it('with only pins, a drop at the end keeps the thread pinned', () => {
      expect(planDrop([t('p1', 2), t('p2', 1)], 'p1', 2)).toEqual({ ids: ['p2', 'p1'] })
    })
  })
})

describe('assignSortOrders (the server rule)', () => {
  it('numbers unplaced threads 0..n-1, reuses held places, fills fresh ones above the lowest', () => {
    expect(assignSortOrders([undefined, undefined])).toEqual([0, 1])
    expect(assignSortOrders([9, 3, 7])).toEqual([3, 7, 9])
    expect(assignSortOrders([undefined, 5, null, 6])).toEqual([3, 4, 5, 6])
    expect(assignSortOrders([2, 2])).toEqual([2, 3])
  })
})

describe('applyReorder', () => {
  it('shows the planned order in the thread-list order', () => {
    const list = [t('a'), t('b'), t('c')]
    const next = applyReorder(list, { ids: ['c', 'a', 'b'] })
    expect(ids(sortThreads(next))).toEqual(['c', 'a', 'b'])
  })

  it('a planned pin takes the pinned group at the planned place', () => {
    const list = [t('p1', 100, 0), t('p2', 50, 1), t('u1'), t('u2')]
    const plan = planDrop(list, 'u2', 1)!
    const next = applyReorder(list, plan, 999)
    expect(next.find((x) => x.id === 'u2')?.pinnedAt).toBe(999)
    expect(ids(sortThreads(next))).toEqual(['p1', 'u2', 'p2', 'u1'])
  })

  it('a planned unpin clears pinnedAt', () => {
    const list = [t('p1', 100), t('u1'), t('u2')]
    const next = applyReorder(list, planDrop(list, 'p1', 3)!)
    expect(next.find((x) => x.id === 'p1')?.pinnedAt).toBeUndefined()
    expect(ids(sortThreads(next))).toEqual(['u1', 'u2', 'p1'])
  })

  it('leaves threads the plan does not name alone, and the input untouched', () => {
    const list = [t('a', undefined, 4), t('b'), t('c', undefined, 1)]
    const next = applyReorder(list, { ids: ['b', 'a'] })
    expect(next[2]).toBe(list[2])
    expect(list[1].sortOrder).toBeUndefined()
  })

  it('every drop in a list then sorts exactly as dropped', () => {
    const list = [t('p', 1), t('a'), t('b'), t('c'), t('d')]
    for (let from = 0; from < list.length; from++) {
      for (let index = 0; index <= list.length; index++) {
        const plan = planDrop(list, list[from].id, index)
        if (!plan) continue
        const shown = ids(sortThreads(applyReorder(list, plan)))
        const group = shown.filter((id) => plan.ids.includes(id))
        expect(group).toEqual(plan.ids)
      }
    }
  })
})

describe('snapshotOrder / restoreOrder', () => {
  it('puts back the order fields only, keeping other changes', () => {
    const list = [{ ...t('a', 5, 2), label: 'old' }, t('b')]
    const snap = snapshotOrder(list, ['a'])
    const changed = applyReorder(list, { ids: ['a'], pinned: false }).map((x) =>
      x.id === 'a' ? { ...x, label: 'renamed meanwhile' } : x
    )
    const back = restoreOrder(changed, snap)
    expect(back[0]).toMatchObject({ pinnedAt: 5, sortOrder: 2, label: 'renamed meanwhile' })
    expect(back[1]).toBe(changed[1])
  })
})

describe('autoScrollStep', () => {
  const box = { top: 100, bottom: 400 }

  it('is 0 away from the edges', () => {
    expect(autoScrollStep(box, 250)).toBe(0)
  })

  it('scrolls up near the top and down near the bottom, faster nearer the edge', () => {
    expect(autoScrollStep(box, 130)).toBeLessThan(0)
    expect(autoScrollStep(box, 105)).toBeLessThan(autoScrollStep(box, 130))
    expect(autoScrollStep(box, 370)).toBeGreaterThan(0)
    expect(autoScrollStep(box, 395)).toBeGreaterThan(autoScrollStep(box, 370))
  })

  it('caps the speed beyond the edge', () => {
    expect(autoScrollStep(box, 0, 40, 14)).toBe(-14)
    expect(autoScrollStep(box, 1000, 40, 14)).toBe(14)
  })

  it('keeps the middle of a short list still', () => {
    expect(autoScrollStep({ top: 0, bottom: 60 }, 30)).toBe(0)
  })
})
