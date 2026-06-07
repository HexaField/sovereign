import { describe, it, expect } from 'vitest'
import type { ParsedTurn } from '@sovereign/core'
import { mergeFetchedHistory } from './merge-history.js'

const turn = (role: ParsedTurn['role'], content: string, timestamp: number): ParsedTurn => ({
  role,
  content,
  timestamp,
  workItems: [],
  thinkingBlocks: []
})

describe('mergeFetchedHistory', () => {
  it('keeps local turns when fetched is empty', () => {
    const local = [turn('user', 'hi', 100)]
    expect(mergeFetchedHistory(local, [])).toEqual(local)
  })

  it('replaces local with fetched when local is empty', () => {
    const fetched = [turn('assistant', 'reply', 200)]
    expect(mergeFetchedHistory([], fetched)).toEqual(fetched)
  })

  // Regression: a just-sent user turn was being wiped because fetchHistory
  // (triggered by an SSE seq gap) returned the persisted history WITHOUT the
  // user message (backend hadn't flushed JSONL yet). Merge must preserve any
  // local turn newer than the latest fetched timestamp.
  it('preserves a local user turn newer than the latest fetched turn', () => {
    const fetched = [turn('assistant', 'old assistant', 100)]
    const local = [turn('assistant', 'old assistant', 100), turn('user', 'just sent', 200)]
    const merged = mergeFetchedHistory(local, fetched)
    expect(merged).toHaveLength(2)
    expect(merged[1].role).toBe('user')
    expect(merged[1].content).toBe('just sent')
  })

  it('drops local turns older than the latest fetched turn (server is canonical)', () => {
    const fetched = [turn('user', 'persisted user', 100), turn('assistant', 'persisted reply', 200)]
    const local = [
      turn('user', 'stale local user', 50) // older than latest fetched
    ]
    const merged = mergeFetchedHistory(local, fetched)
    expect(merged).toEqual(fetched)
  })

  it('preserves multiple local turns when several are newer', () => {
    const fetched = [turn('assistant', 'a', 50)]
    const local = [turn('user', 'u1', 100), turn('assistant', 'a1', 150), turn('user', 'u2', 200)]
    const merged = mergeFetchedHistory(local, fetched)
    expect(merged.map((t) => t.content)).toEqual(['a', 'u1', 'a1', 'u2'])
  })

  it('does NOT duplicate when fetched already contains the same final turn', () => {
    // The synthesized user chat.turn fired BEFORE the JSONL flush. fetchHistory
    // arrives AFTER the flush — it already includes the same user message.
    // Without dedup we'd render the user bubble twice.
    const fetched = [turn('assistant', 'reply', 100), turn('user', 'just sent', 200)]
    const local = [turn('assistant', 'reply', 100), turn('user', 'just sent', 200)]
    const merged = mergeFetchedHistory(local, fetched)
    expect(merged).toEqual(fetched)
    expect(merged).toHaveLength(2)
  })

  it('handles missing timestamps gracefully (treats as zero, drops them)', () => {
    const fetched = [turn('assistant', 'a', 100)]
    const local = [
      { role: 'user' as const, content: 'no-ts', workItems: [], thinkingBlocks: [] } as unknown as ParsedTurn
    ]
    // Local user has no timestamp → treated as 0 → older than latest fetched 100 → dropped.
    expect(mergeFetchedHistory(local, fetched)).toEqual(fetched)
  })
})
