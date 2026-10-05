import { describe, it, expect } from 'vitest'
import { recycleWanted, recycleExhausted } from './recycle-gate.js'

const base = { maxTokens: 1_000_000, thresholdPercent: 55, regrowPercent: 10 }

describe('recycleWanted', () => {
  it('recycles past the threshold, not below it', () => {
    expect(recycleWanted({ ...base, filled: 560_000 })).toBe(true)
    expect(recycleWanted({ ...base, filled: 540_000 })).toBe(false)
  })

  it('after a recycle, waits for the context to grow a regrow margin past what it left', () => {
    // The loop seen on a long thread: 644k → 630k, still over 55 %.
    expect(recycleWanted({ ...base, filled: 644_000, floor: 630_000 })).toBe(false)
    expect(recycleWanted({ ...base, filled: 729_000, floor: 630_000 })).toBe(false)
    expect(recycleWanted({ ...base, filled: 730_000, floor: 630_000 })).toBe(true)
  })

  it('never recycles a session where pruning stopped helping', () => {
    expect(recycleWanted({ ...base, filled: 900_000, floor: 630_000, exhausted: true })).toBe(false)
  })

  it('ignores an unknown fill or window', () => {
    expect(recycleWanted({ ...base, filled: 0 })).toBe(false)
    expect(recycleWanted({ ...base, maxTokens: 0, filled: 10 })).toBe(false)
  })
})

describe('recycleExhausted', () => {
  it('flags a recycle that freed under the minimum share of the context', () => {
    expect(recycleExhausted(644_000, 630_000, 5)).toBe(true) // 2.2 %
    expect(recycleExhausted(644_000, 500_000, 5)).toBe(false) // 22 %
    expect(recycleExhausted(0, 0, 5)).toBe(false)
  })
})
