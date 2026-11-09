import { describe, it, expect } from 'vitest'
import { assignSortOrders } from './sort-order.js'

describe('assignSortOrders', () => {
  it('numbers a list with no places 0..n-1', () => {
    expect(assignSortOrders([undefined, undefined, undefined])).toEqual([0, 1, 2])
  })

  it('deals the same places out again in the new order', () => {
    // Threads held 3, 7, 9; the new order is the one that held 9, then 3, then 7.
    expect(assignSortOrders([9, 3, 7])).toEqual([3, 7, 9])
  })

  it('gives threads with no place fresh ones just above the lowest held', () => {
    expect(assignSortOrders([undefined, 5, undefined, 6])).toEqual([3, 4, 5, 6])
  })

  it('separates equal places so nothing ties', () => {
    expect(assignSortOrders([0, 0, 1])).toEqual([0, 1, 2])
  })

  it('returns strictly increasing values', () => {
    const out = assignSortOrders([4, undefined, -2, 4, undefined, 10])
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1])
  })
})
