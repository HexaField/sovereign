// Forge meta store: saved views and related edges, persisted like tasks.

import { afterAll, describe, expect, it } from 'vitest'
import { createForgeMetaStore } from './meta.js'
import type { FakeAd4m } from './testing/helpers.js'
import { cleanupTempDirs, createFakeAd4m, quietLog, tempDir, until } from './testing/helpers.js'

afterAll(cleanupTempDirs)

function open(dir: string, ad4m: FakeAd4m | null) {
  return createForgeMetaStore({
    dir,
    connect: ad4m ? ad4m.connect : null,
    onReconnect: ad4m ? ad4m.onReconnect : undefined,
    snapshotDelayMs: 1,
    retryMs: 60_000,
    log: quietLog()
  })
}

describe('forge meta store', () => {
  it('saves, lists by membrane, replaces and deletes views', () => {
    const meta = open(tempDir(), null)
    const all = meta.saveView({
      membrane: 'coasys',
      title: 'ad4m + WE',
      repos: ['coasys/ad4m', 'coasys/we', 'coasys/we']
    })
    const mine = meta.saveView({
      membrane: 'coasys',
      title: 'Needs my review',
      filters: { requestedFromMe: true },
      height: 320
    })
    meta.saveView({ membrane: 'home', title: 'Home' })
    expect(all.id).toMatch(/^forge-view:\/\//)
    expect(all.repos).toEqual(['coasys/ad4m', 'coasys/we'])
    expect(
      meta
        .listViews('coasys')
        .map((v) => v.title)
        .sort()
    ).toEqual(['Needs my review', 'ad4m + WE'])
    const replaced = meta.saveView({ ...mine, title: 'Review queue' })
    expect(replaced.id).toBe(mine.id)
    expect(meta.getView(mine.id)).toMatchObject({
      title: 'Review queue',
      filters: { requestedFromMe: true },
      height: 320
    })
    expect(meta.deleteView(all.id)).toBe(true)
    expect(meta.deleteView(all.id)).toBe(false)
    expect(meta.listViews()).toHaveLength(2)
    expect(() => meta.saveView({ membrane: 'coasys', title: ' ' })).toThrow(/title/)
    meta.dispose()
  })

  it('adds related edges once per node pair, in either direction', () => {
    const meta = open(tempDir(), null)
    const a = 'github:github.com/coasys/ad4m#712'
    const b = 'github:github.com/coasys/we#159'
    const e1 = meta.addEdge({
      from: a,
      to: b,
      reason: 'Same feature',
      confidence: 0.6,
      source: 'rethink',
      membrane: 'coasys'
    })
    const e2 = meta.addEdge({ from: b, to: a, reason: 'Paired by hand', confidence: 2, source: 'josh' })
    expect(e2.id).toBe(e1.id)
    expect(e2).toMatchObject({
      from: a,
      to: b,
      reason: 'Paired by hand',
      confidence: 1,
      source: 'josh',
      membrane: 'coasys'
    })
    expect(meta.listEdges({ node: b })).toHaveLength(1)
    expect(meta.listEdges({ membrane: 'home' })).toHaveLength(0)
    expect(() => meta.addEdge({ from: a, to: a, reason: '', source: 'sync' })).toThrow(/itself/)
    expect(meta.deleteEdge(e1.id)).toBe(true)
    expect(meta.listEdges()).toEqual([])
    meta.dispose()
  })

  it('keeps views and edges across a restart with AD4M down, then replays them', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const dir = tempDir()
    const first = open(dir, ad4m)
    await first.settled()
    const view = first.saveView({
      membrane: 'coasys',
      title: 'All',
      repos: ['coasys/ad4m'],
      filters: { states: ['open'] }
    })
    const edge = first.addEdge({ from: 'task:1', to: 'plan:we/plans/x.md', reason: 'plan names it', source: 'rethink' })
    first.dispose()

    const second = open(dir, ad4m)
    expect(second.getView(view.id)).toEqual(view)
    expect(second.listEdges()).toEqual([edge])
    expect(second.status().pending).toBe(2)

    ad4m.up()
    await until(() => second.status().pending === 0 && second.status().loadedFromBackend)
    const fresh = open(tempDir(), ad4m)
    await fresh.settled()
    expect(fresh.getView(view.id)).toEqual(view)
    expect(fresh.listEdges()).toEqual([edge])

    // Delete replays too, and leaves nothing of the view in AD4M.
    fresh.deleteView(view.id)
    await until(() => fresh.status().pending === 0)
    expect(ad4m.count({ source: view.id })).toBe(0)
    second.dispose()
    fresh.dispose()
  })
})
