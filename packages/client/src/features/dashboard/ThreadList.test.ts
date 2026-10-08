import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))

import { applyThreadUpdate, shortRelativeTime } from './ThreadList.jsx'

const T0 = 1_800_000_000_000
const thread = (id: string, lastActivity: number) => ({
  id,
  label: id,
  agentStatus: 'idle',
  lastActivity,
  archived: false
})

describe('shortRelativeTime', () => {
  it('ages against the given clock, not the time of the call', () => {
    expect(shortRelativeTime(T0, T0 + 30_000)).toBe('now')
    expect(shortRelativeTime(T0, T0 + 5 * 60_000)).toBe('5m')
    expect(shortRelativeTime(T0, T0 + 3 * 3600_000)).toBe('3h')
    expect(shortRelativeTime(T0, T0 + 2 * 86400_000)).toBe('2d')
  })
})

describe('applyThreadUpdate', () => {
  const list = [thread('a', T0), thread('b', T0)]

  it('applies a { threadId, patch } update to that thread only', () => {
    const next = applyThreadUpdate(list, { threadId: 'a', patch: { lastActivity: T0 + 1000 } })
    expect(next.map((t) => t.lastActivity)).toEqual([T0 + 1000, T0])
  })

  it('applies a { thread } update, e.g. a rename', () => {
    const next = applyThreadUpdate(list, { thread: { id: 'b', label: 'renamed' } })
    expect(next[1]).toMatchObject({ id: 'b', label: 'renamed', lastActivity: T0 })
  })

  it('never moves lastActivity backwards (the list may hold a newer on-disk time)', () => {
    const next = applyThreadUpdate([thread('a', T0 + 5000)], { threadId: 'a', patch: { lastActivity: T0 } })
    expect(next[0].lastActivity).toBe(T0 + 5000)
  })

  it('ignores a payload without an id', () => {
    expect(applyThreadUpdate(list, { patch: { lastActivity: T0 + 1 } })).toBe(list)
  })
})
