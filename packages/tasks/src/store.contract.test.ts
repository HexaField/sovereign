// TaskStore contract — every store behaves the same through the interface.
// Runs against the in-memory store, the resilient store with no AD4M
// (snapshot only), and the resilient store over a fake AD4M perspective.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskStore } from './store.js'
import { createInMemoryTaskStore, createResilientTaskStore } from './store.js'
import type { TaskRecord } from './types.js'
import { cleanupTempDirs, createFakeAd4m, quietLog, tempDir } from './testing/helpers.js'

function record(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    name: `Task ${id}`,
    state: 'pending',
    threadId: null,
    description: null,
    transientState: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: null,
    tags: [],
    membrane: null,
    isStream: false,
    ...over
  }
}

const STORES: Array<[string, () => TaskStore]> = [
  ['in-memory', () => createInMemoryTaskStore()],
  [
    'resilient, local only',
    () => createResilientTaskStore({ dir: tempDir(), connect: null, snapshotDelayMs: 1, log: quietLog() })
  ],
  [
    'resilient, fake AD4M',
    () =>
      createResilientTaskStore({
        dir: tempDir(),
        connect: createFakeAd4m().connect,
        snapshotDelayMs: 1,
        log: quietLog()
      })
  ]
]

afterAll(cleanupTempDirs)

describe.each(STORES)('TaskStore contract — %s', (_name, make) => {
  let store: TaskStore
  beforeEach(() => {
    store = make()
  })
  afterEach(() => store.dispose())

  it('creates and reads a task with every field', async () => {
    const rec = record('task://a', {
      name: 'Write the spec',
      state: 'in_progress',
      threadId: 'thread-1',
      description: 'Line one\nline two — with ünïcode',
      transientState: 'CI pending',
      updatedAt: '2026-10-02T00:00:00.000Z',
      tags: ['forge', 'p0'],
      membrane: 'coasys',
      isStream: true,
      provider: { kind: 'plan', project: 'sovereign', path: 'plans/forge.md', status: 'in_progress' }
    })
    const created = await store.create(rec)
    expect(created).toEqual({ ...rec, parentTasks: [], childTasks: [] })
    expect(await store.get('task://a')).toEqual(created)
  })

  it('returns null for a missing task and refuses a duplicate id', async () => {
    expect(await store.get('task://nope')).toBeNull()
    await store.create(record('task://a'))
    await expect(store.create(record('task://a'))).rejects.toThrow(/already exists/)
  })

  it('updates only the given fields, and null clears', async () => {
    await store.create(record('task://a', { threadId: 't1', description: 'd', tags: ['x'] }))
    const updated = await store.update('task://a', { state: 'completed', threadId: null, tags: ['y', 'z'] })
    expect(updated).toMatchObject({ state: 'completed', threadId: null, description: 'd', tags: ['y', 'z'] })
    await expect(store.update('task://missing', { name: 'x' })).rejects.toThrow(/not found/)
  })

  it('links many-to-many, both directions, without duplicates', async () => {
    for (const id of ['p1', 'p2', 'c']) await store.create(record(`task://${id}`))
    await store.addLink('task://p1', 'task://c')
    await store.addLink('task://p2', 'task://c')
    await store.addLink('task://p1', 'task://c')
    const child = await store.get('task://c')
    expect(child!.parentTasks.map((p) => p.id).sort()).toEqual(['task://p1', 'task://p2'])
    expect((await store.get('task://p1'))!.childTasks).toEqual([
      { id: 'task://c', name: 'Task task://c', state: 'pending' }
    ])
    await expect(store.addLink('task://p1', 'task://missing')).rejects.toThrow(/not found/)
  })

  it('unlinks, and unlinking twice is harmless', async () => {
    for (const id of ['p', 'c']) await store.create(record(`task://${id}`))
    await store.addLink('task://p', 'task://c')
    await store.removeLink('task://p', 'task://c')
    await store.removeLink('task://p', 'task://c')
    expect((await store.get('task://c'))!.parentTasks).toEqual([])
    expect((await store.get('task://p'))!.childTasks).toEqual([])
  })

  it('walks ancestors through several levels', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await store.create(record(`task://${id}`))
    await store.addLink('task://a', 'task://b')
    await store.addLink('task://b', 'task://c')
    await store.addLink('task://d', 'task://c')
    expect([...(await store.ancestors('task://c'))].sort()).toEqual(['task://a', 'task://b', 'task://d'])
  })

  it('lists with counts and basic filters', async () => {
    await store.create(record('task://p', { threadId: 't1', state: 'in_progress' }))
    await store.create(record('task://c'))
    await store.addLink('task://p', 'task://c')
    const all = await store.list()
    expect(all).toHaveLength(2)
    expect(all.find((t) => t.id === 'task://p')).toMatchObject({ childCount: 1, parentCount: 0, isStream: false })
    expect((await store.list({ threadId: null })).map((t) => t.id)).toEqual(['task://c'])
    expect((await store.list({ threadId: 't1' })).map((t) => t.id)).toEqual(['task://p'])
    expect((await store.list({ state: 'in_progress' })).map((t) => t.id)).toEqual(['task://p'])
    expect((await store.list({ parentId: 'task://p' })).map((t) => t.id)).toEqual(['task://c'])
    expect((await store.list({ rootsOnly: true })).map((t) => t.id)).toEqual(['task://p'])
  })

  it('finds a task by provider key', async () => {
    await store.create(
      record('task://pr', {
        provider: {
          kind: 'change',
          refs: [{ forge: 'github', host: 'github.com', repo: 'org/repo', kind: 'change', id: '5' }],
          url: 'https://github.com/org/repo/pull/5',
          status: 'open',
          checksStatus: 'unknown',
          reviewDecision: 'unknown',
          unresolvedComments: 0,
          lastPolledAt: '2026-10-01T00:00:00.000Z'
        }
      })
    )
    await store.create(
      record('task://plan', { provider: { kind: 'plan', project: 'p', path: 'a.md', status: 'planned' } })
    )
    expect((await store.findByProviderKey('github:github.com/org/repo#5'))!.id).toBe('task://pr')
    expect((await store.findByProviderKey('plan:p/a.md'))!.id).toBe('task://plan')
    expect(await store.findByProviderKey('plan:p/b.md')).toBeNull()
  })

  it('returns copies: mutating a result never changes the store', async () => {
    await store.create(record('task://a', { tags: ['x'] }))
    const t = await store.get('task://a')
    t!.tags.push('mutated')
    t!.name = 'mutated'
    expect(await store.get('task://a')).toMatchObject({ name: 'Task task://a', tags: ['x'] })
  })
})
