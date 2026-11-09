import { describe, it, expect, vi } from 'vitest'

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }))

import {
  applyThreadUpdate,
  pinInList,
  renameInList,
  removeThread,
  reorderInList,
  shortRelativeTime,
  type ThreadEntry
} from './ThreadList.jsx'
import { sortThreads } from '../threads/thread-order.js'

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

describe('removeThread / renameInList', () => {
  const list = [thread('a', T0), thread('b', T0)]

  it('drops a deleted thread', () => {
    expect(removeThread(list, 'a').map((t) => t.id)).toEqual(['b'])
    expect(removeThread(list, 'missing')).toHaveLength(2)
  })

  it('applies a rename to that thread only', () => {
    expect(renameInList(list, 'b', 'Renamed').map((t) => t.label)).toEqual(['a', 'Renamed'])
  })
})

describe('pinInList', () => {
  const list = [thread('a', T0), thread('b', T0)]

  it('pins and unpins that thread only', () => {
    const pinned = pinInList(list, 'b', 5)
    expect(pinned.map((t) => t.pinnedAt)).toEqual([undefined, 5])
    expect(pinInList(pinned, 'b', undefined).map((t) => t.pinnedAt)).toEqual([undefined, undefined])
  })

  it('takes an unpin broadcast ({ pinnedAt: null }) through applyThreadUpdate', () => {
    const next = applyThreadUpdate(pinInList(list, 'a', 5), { threadId: 'a', patch: { pinnedAt: null } })
    expect(next[0].pinnedAt).toBeNull()
  })
})

describe('reorderInList (Overview drag to reorder)', () => {
  const entry = (
    id: string,
    lastActivity: number,
    extra: { pinnedAt?: number; sortOrder?: number } = {}
  ): ThreadEntry => ({
    id,
    label: id,
    agentStatus: 'idle',
    lastActivity,
    archived: false,
    ...extra
  })
  const order = (list: Array<{ id: string }>) => sortThreads(list as any[]).map((t: { id: string }) => t.id)

  it('shows the new order at once and saves the plan', async () => {
    let list = [entry('a', 3), entry('b', 2), entry('c', 1)]
    const save = vi.fn(() => Promise.resolve())
    const done = reorderInList(
      () => list,
      (next) => (list = next),
      { ids: ['c', 'b', 'a'] },
      save
    )
    expect(order(list)).toEqual(['c', 'b', 'a'])
    await done
    expect(save).toHaveBeenCalledWith({ ids: ['c', 'b', 'a'] })
    expect(order(list)).toEqual(['c', 'b', 'a'])
  })

  it('puts the old order back when the save fails, keeping changes made meanwhile', async () => {
    let list = [entry('a', 3), entry('b', 2, { pinnedAt: 7 })]
    const save = vi.fn(async () => {
      list = list.map((t) => (t.id === 'a' ? { ...t, label: 'renamed' } : t))
      throw new Error('Reorder failed (500)')
    })
    await expect(
      reorderInList(
        () => list,
        (next) => (list = next),
        { ids: ['b', 'a'], pinned: false },
        save
      )
    ).rejects.toThrow('Reorder failed (500)')
    expect(order(list)).toEqual(['b', 'a'])
    expect(list.find((t) => t.id === 'b')?.pinnedAt).toBe(7)
    expect(list.find((t) => t.id === 'a')?.label).toBe('renamed')
  })

  it('applies a sortOrder broadcast, and a null one as never placed', () => {
    let list = [entry('a', 3), entry('b', 1)]
    list = applyThreadUpdate(list, { threadId: 'b', patch: { sortOrder: 0 } })
    list = applyThreadUpdate(list, { threadId: 'a', patch: { sortOrder: 1 } })
    expect(order(list)).toEqual(['b', 'a'])
    list = applyThreadUpdate(list, { threadId: 'a', patch: { sortOrder: null } })
    expect(order(list)).toEqual(['a', 'b'])
  })
})
