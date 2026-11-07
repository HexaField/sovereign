import { describe, it, expect } from 'vitest'
import { recycleWanted } from './recycle-gate.js'

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

  it('recycles again once a session that pruning barely shrank has regrown', () => {
    // 610k → 608k left nothing to prune; 12 h of new tool output later there is.
    expect(recycleWanted({ ...base, filled: 650_000, floor: 608_000 })).toBe(false)
    expect(recycleWanted({ ...base, filled: 710_000, floor: 608_000 })).toBe(true)
  })

  it('uses the cold threshold once the session was idle past the prompt-cache TTL', () => {
    const cold = { ...base, coldThresholdPercent: 20, cacheTtlMs: 3_600_000 }
    // 30 % full: under 55 %, over 20 %.
    expect(recycleWanted({ ...cold, filled: 300_000, idleMs: 59 * 60_000 })).toBe(false)
    expect(recycleWanted({ ...cold, filled: 300_000, idleMs: 61 * 60_000 })).toBe(true)
    expect(recycleWanted({ ...cold, filled: 150_000, idleMs: 61 * 60_000 })).toBe(false)
    // The floor still holds on a cold cache.
    expect(recycleWanted({ ...cold, filled: 300_000, idleMs: 61 * 60_000, floor: 250_000 })).toBe(false)
  })

  it('ignores an unknown fill or window', () => {
    expect(recycleWanted({ ...base, filled: 0 })).toBe(false)
    expect(recycleWanted({ ...base, maxTokens: 0, filled: 10 })).toBe(false)
  })
})
