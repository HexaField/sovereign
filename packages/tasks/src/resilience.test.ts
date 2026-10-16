// Resilience of the runtime task store when AD4M comes and goes:
// outbox while down, ordered replay, crash mid-replay, snapshot restarts,
// seeding, dead letters, legacy data.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createResilientTaskStore, TASK_OUTBOX_FILE, TASK_SNAPSHOT_FILE } from './store.js'
import type { TaskStore } from './store.js'
import { P, RDF_TYPE, T } from './ontology.js'
import { toLiteral } from './link-graph.js'
import type { TaskRecord } from './types.js'
import type { FakeAd4m } from './testing/helpers.js'
import { cleanupTempDirs, createFakeAd4m, quietLog, tempDir, until } from './testing/helpers.js'

afterAll(cleanupTempDirs)

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

function open(dir: string, ad4m: FakeAd4m | null, over: { retryMs?: number; callTimeoutMs?: number } = {}): TaskStore {
  return createResilientTaskStore({
    dir,
    connect: ad4m ? ad4m.connect : null,
    onReconnect: ad4m ? ad4m.onReconnect : undefined,
    snapshotDelayMs: 1,
    retryMs: over.retryMs ?? 60_000,
    callTimeoutMs: over.callTimeoutMs,
    log: quietLog()
  })
}

function outboxLines(dir: string): number {
  try {
    return fs.readFileSync(path.join(dir, TASK_OUTBOX_FILE), 'utf-8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

/** Writes a few ops that only end right if replayed in order. */
async function writeOrderedOps(store: TaskStore): Promise<void> {
  await store.create(record('task://a', { name: 'one' }))
  await store.create(record('task://b'))
  await store.update('task://a', { name: 'two' })
  await store.addLink('task://a', 'task://b')
  await store.update('task://a', { name: 'three', tags: ['x', 'y'] })
  await store.removeLink('task://a', 'task://b')
  await store.addLink('task://b', 'task://a')
  await store.update('task://b', { threadId: 'thread-9', state: 'in_progress' })
}

async function expectOrderedState(store: TaskStore): Promise<void> {
  const a = await store.get('task://a')
  const b = await store.get('task://b')
  expect(a).toMatchObject({ name: 'three', tags: ['x', 'y'], childTasks: [] })
  expect(a!.parentTasks.map((p) => p.id)).toEqual(['task://b'])
  expect(b).toMatchObject({ threadId: 'thread-9', state: 'in_progress', parentTasks: [] })
}

/** Exactly one link per scalar property, and the expected subtask links. */
function expectNoDuplicateLinks(ad4m: FakeAd4m): void {
  const seen = new Map<string, number>()
  for (const l of ad4m.links) {
    const k = `${l.source} ${l.predicate} ${l.target}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  for (const [k, n] of seen) expect(n, k).toBe(1)
  for (const id of ['task://a', 'task://b']) {
    expect(ad4m.count({ source: id, predicate: P.name })).toBe(1)
    expect(ad4m.count({ source: id, predicate: RDF_TYPE, target: T.Task })).toBe(1)
  }
}

describe('resilient task store — AD4M down', () => {
  it('keeps working while AD4M is down and queues every write in the outbox', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const dir = tempDir()
    const store = open(dir, ad4m)
    await store.settled()
    expect(store.status().backend).toBe('down')

    await writeOrderedOps(store)
    await expectOrderedState(store)
    expect(store.status().pending).toBe(8)
    expect(outboxLines(dir)).toBe(8)
    expect(ad4m.links).toHaveLength(0)
    store.dispose()
  })

  it('replays the outbox in order when AD4M comes back (reconnect signal)', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const dir = tempDir()
    const store = open(dir, ad4m)
    await store.settled()
    await writeOrderedOps(store)

    ad4m.up()
    await until(() => store.status().pending === 0 && store.status().backend === 'connected')
    expect(outboxLines(dir)).toBe(0)
    await expectOrderedState(store)
    expectNoDuplicateLinks(ad4m)

    // A fresh store with an empty data dir reads the same graph from AD4M.
    const fresh = open(tempDir(), ad4m)
    await fresh.settled()
    await expectOrderedState(fresh)
    store.dispose()
    fresh.dispose()
  })

  it('acts on a reconnect signal that arrives while a failing pass is still running', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const store = open(tempDir(), ad4m)
    await store.settled()
    await store.create(record('task://a')) // starts a pass that will fail
    ad4m.up() // arrives before that pass has finished
    await until(() => store.status().pending === 0)
    expect(store.status().backend).toBe('connected')
    store.dispose()
  })

  it('retries on its interval when no reconnect signal comes', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const dir = tempDir()
    const store = createResilientTaskStore({
      dir,
      connect: ad4m.connect,
      snapshotDelayMs: 1,
      retryMs: 20,
      log: quietLog()
    })
    await store.settled()
    await store.create(record('task://a'))
    ad4m.state.down = false // back, silently
    await until(() => store.status().pending === 0)
    expect(ad4m.count({ source: 'task://a', predicate: P.name })).toBe(1)
    store.dispose()
  })

  it('leaves no duplicates after a crash mid-replay', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const dir = tempDir()
    const first = open(dir, ad4m, { callTimeoutMs: 60_000 })
    await first.settled()
    await writeOrderedOps(first)

    // AD4M returns; the process dies after three ops reached AD4M.
    ad4m.state.hangAfter = 3
    ad4m.up()
    await until(() => ad4m.state.mutations === 3)
    expect(outboxLines(dir)).toBe(8) // nothing confirmed yet: the whole outbox replays
    first.dispose()

    // Restart: the outbox replays from the top over AD4M that already holds three ops.
    ad4m.state.hangAfter = Infinity
    const second = open(dir, ad4m)
    await second.settled()
    await until(() => second.status().pending === 0)
    await expectOrderedState(second)
    expectNoDuplicateLinks(ad4m)

    const fresh = open(tempDir(), ad4m)
    await fresh.settled()
    await expectOrderedState(fresh)
    second.dispose()
    fresh.dispose()
  })

  it('skips a torn last outbox line from a crash mid-append', async () => {
    const ad4m = createFakeAd4m()
    ad4m.down()
    const dir = tempDir()
    const store = open(dir, ad4m)
    await store.settled()
    await store.create(record('task://a', { name: 'kept' }))
    store.dispose()
    fs.rmSync(path.join(dir, TASK_SNAPSHOT_FILE))
    fs.appendFileSync(path.join(dir, TASK_OUTBOX_FILE), '{"seq":2,"at":"x","op":{"type":"task.upd')

    const again = open(dir, ad4m)
    expect((await again.get('task://a'))!.name).toBe('kept')
    again.dispose()
  })
})

describe('resilient task store — restarts', () => {
  it('restarts from the local snapshot when AD4M is down at boot', async () => {
    const ad4m = createFakeAd4m()
    const dir = tempDir()
    const first = open(dir, ad4m)
    await first.settled()
    await writeOrderedOps(first)
    await until(() => first.status().pending === 0)
    first.dispose()

    ad4m.down()
    const second = open(dir, ad4m)
    await expectOrderedState(second) // served before any AD4M answer
    await second.settled()
    expect(second.status()).toMatchObject({ backend: 'down', loadedFromBackend: false, pending: 0 })
    second.dispose()
  })

  it('loses nothing across: write, AD4M down, restart, write, AD4M up', async () => {
    const ad4m = createFakeAd4m()
    const dir = tempDir()
    const first = open(dir, ad4m)
    await first.settled()
    await first.create(record('task://before', { membrane: 'coasys' }))
    await until(() => first.status().pending === 0)
    ad4m.down()
    await first.create(record('task://while-down-1'))
    await first.addLink('task://before', 'task://while-down-1')
    first.dispose()

    const second = open(dir, ad4m)
    await second.settled()
    await second.create(record('task://while-down-2'))
    await second.update('task://before', { state: 'in_progress', threadId: 'thread-1' })
    expect(second.status().pending).toBe(4)

    ad4m.up()
    await until(() => second.status().pending === 0 && second.status().loadedFromBackend)
    const fresh = open(tempDir(), ad4m)
    await fresh.settled()
    const ids = (await fresh.list()).map((t) => t.id).sort()
    expect(ids).toEqual(['task://before', 'task://while-down-1', 'task://while-down-2'])
    expect(await fresh.get('task://before')).toMatchObject({
      state: 'in_progress',
      threadId: 'thread-1',
      membrane: 'coasys',
      childTasks: [{ id: 'task://while-down-1', name: 'Task task://while-down-1', state: 'pending' }]
    })
    second.dispose()
    fresh.dispose()
  })

  it('a local-only store restarts from its snapshot and keeps no outbox', async () => {
    const dir = tempDir()
    const first = open(dir, null)
    await writeOrderedOps(first)
    first.dispose()
    expect(outboxLines(dir)).toBe(0)
    const second = open(dir, null)
    await expectOrderedState(second)
    second.dispose()
  })

  it('seeds AD4M from a local-only snapshot when AD4M is configured later', async () => {
    const dir = tempDir()
    const local = open(dir, null)
    await writeOrderedOps(local)
    local.dispose()

    const ad4m = createFakeAd4m()
    const store = open(dir, ad4m)
    await store.settled()
    await until(() => store.status().pending === 0)
    await expectOrderedState(store)
    const fresh = open(tempDir(), ad4m)
    await fresh.settled()
    await expectOrderedState(fresh)
    store.dispose()
    fresh.dispose()
  })

  it('reseeds when the perspective is replaced (a new uuid)', async () => {
    const dir = tempDir()
    const old = createFakeAd4m('perspective-1')
    const first = open(dir, old)
    await first.settled()
    await writeOrderedOps(first)
    await until(() => first.status().pending === 0)
    first.dispose()

    const replaced = createFakeAd4m('perspective-2')
    const second = open(dir, replaced)
    await second.settled()
    await until(() => second.status().pending === 0)
    await expectOrderedState(second)
    expect(replaced.count({ source: 'task://a', predicate: P.name })).toBe(1)
    second.dispose()
  })

  it('takes AD4M as the source of truth once it answers', async () => {
    const ad4m = createFakeAd4m()
    const dir = tempDir()
    const first = open(dir, ad4m)
    await first.settled()
    await first.create(record('task://a'))
    await until(() => first.status().pending === 0)
    first.dispose()

    // Another writer adds a task to the perspective while this store is off.
    const other = open(tempDir(), ad4m)
    await other.settled()
    await other.create(record('task://from-elsewhere'))
    await until(() => other.status().pending === 0)
    other.dispose()

    const second = open(dir, ad4m)
    await second.settled()
    expect((await second.list()).map((t) => t.id).sort()).toEqual(['task://a', 'task://from-elsewhere'])
    second.dispose()
  })

  it('writes the snapshot atomically, ignoring a stray temp file', async () => {
    const dir = tempDir()
    const first = open(dir, null)
    await first.create(record('task://a'))
    first.dispose()
    fs.writeFileSync(path.join(dir, `${TASK_SNAPSHOT_FILE}.tmp-999`), '{ half written')
    const raw = JSON.parse(fs.readFileSync(path.join(dir, TASK_SNAPSHOT_FILE), 'utf-8'))
    expect(raw).toMatchObject({ version: 1, backendId: null })
    const second = open(dir, null)
    expect(await second.get('task://a')).not.toBeNull()
    second.dispose()
  })
})

describe('resilient task store — rejected ops and legacy data', () => {
  it('dead-letters an op AD4M keeps rejecting while reachable, and carries on', async () => {
    const ad4m = createFakeAd4m()
    const dir = tempDir()
    const store = open(dir, ad4m)
    await store.settled()
    ad4m.state.rejectNext = 5
    await store.create(record('task://poison'))
    await store.create(record('task://fine'))
    for (let i = 0; i < 8 && store.status().pending > 0; i++) await store.sync()
    await until(() => store.status().pending === 0)
    expect(store.status().deadLettered).toBe(1)
    expect(fs.readFileSync(path.join(dir, `${TASK_OUTBOX_FILE}.dead.jsonl`), 'utf-8')).toContain('task://poison')
    expect(ad4m.count({ source: 'task://fine', predicate: P.name })).toBe(1)
    // The local copy still has the task; it is not lost, only not in AD4M.
    expect(await store.get('task://poison')).not.toBeNull()
    store.dispose()
  })

  it('migrates a legacy github-pr provider found in the snapshot', async () => {
    const dir = tempDir()
    fs.writeFileSync(
      path.join(dir, TASK_SNAPSHOT_FILE),
      JSON.stringify({
        version: 1,
        savedAt: '2026-10-01T00:00:00.000Z',
        backendId: null,
        state: {
          tasks: [
            {
              id: 'task://old',
              name: 'PR #7: Old',
              state: 'in_progress',
              tags: ['github-pr'],
              createdAt: '2026-09-01T00:00:00.000Z',
              provider: {
                kind: 'github-pr',
                url: 'https://github.com/org/repo/pull/7',
                repo: 'org/repo',
                number: 7,
                prStatus: 'open',
                checksStatus: 'failing',
                reviewDecision: 'approved',
                lastPolledAt: '2026-09-02T00:00:00.000Z',
                unresolvedComments: 2
              }
            }
          ],
          links: []
        }
      })
    )
    const store = open(dir, null)
    const t = await store.get('task://old')
    expect(t).toMatchObject({ membrane: null, isStream: false, threadId: null })
    expect(t!.provider).toEqual({
      kind: 'change',
      refs: [{ forge: 'github', host: 'github.com', repo: 'org/repo', kind: 'change', id: '7' }],
      url: 'https://github.com/org/repo/pull/7',
      status: 'open',
      checksStatus: 'failing',
      reviewDecision: 'approved',
      unresolvedComments: 2,
      lastPolledAt: '2026-09-02T00:00:00.000Z'
    })
    expect((await store.findByProviderKey('github:github.com/org/repo#7'))!.id).toBe('task://old')
    store.dispose()
  })

  it('migrates a legacy provider found in AD4M', async () => {
    const ad4m = createFakeAd4m()
    const legacy = {
      kind: 'github-pr',
      url: 'https://github.com/org/repo/pull/8',
      repo: 'org/repo',
      number: 8,
      prStatus: 'merged',
      checksStatus: 'passing',
      reviewDecision: 'approved',
      lastPolledAt: '2026-09-02T00:00:00.000Z',
      unresolvedComments: 0
    }
    ad4m.links.push(
      { source: 'task://legacy', predicate: RDF_TYPE, target: T.Task },
      { source: 'task://legacy', predicate: P.name, target: toLiteral('PR #8') },
      { source: 'task://legacy', predicate: P.state, target: toLiteral('completed') },
      { source: 'task://legacy', predicate: P.provider, target: toLiteral(JSON.stringify(legacy)) }
    )
    const store = open(tempDir(), ad4m)
    await store.settled()
    expect((await store.get('task://legacy'))!.provider).toMatchObject({ kind: 'change', status: 'merged' })
    store.dispose()
  })
})
