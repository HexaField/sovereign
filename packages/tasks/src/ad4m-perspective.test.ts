// The real AD4M adapter (ad4m-perspective.ts) against a fake SDK client:
// perspective lookup, class registration, link reads and mutations.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Ad4mClientManager } from '@sovereign/ad4m'
import { createForgePerspective } from './ad4m-perspective.js'
import { FORGE_SHACL_CLASSES } from './ontology.js'
import { createResilientTaskStore } from './store.js'
import { cleanupTempDirs, quietLog, tempDir, until } from './testing/helpers.js'

afterAll(cleanupTempDirs)

interface Expr {
  __typename?: string
  author: string
  timestamp: string
  data: { __typename?: string; source: string; predicate: string; target: string }
  proof: { __typename?: string; signature: string; key: string }
}

function fakeProxy(uuid: string, name: string, isUp: () => boolean = () => true) {
  const links: Expr[] = []
  const check = () => {
    if (!isUp()) throw new Error('connect ECONNREFUSED')
  }
  const classes = new Map<string, string>()
  const calls = { mutations: 0, removalsWithTypename: 0 }
  let n = 0
  return {
    uuid,
    name,
    links,
    classes,
    calls,
    async get(q: { source?: string; predicate?: string; target?: string }) {
      check()
      return links
        .filter(
          (l) =>
            (!q.source || l.data.source === q.source) &&
            (!q.predicate || l.data.predicate === q.predicate) &&
            (!q.target || l.data.target === q.target)
        )
        .map((l) => structuredClone(l))
    },
    async linkMutations(m: { additions: Array<Expr['data']>; removals: Expr[] }) {
      check()
      calls.mutations++
      for (const r of m.removals) {
        if (r.__typename || r.data.__typename || r.proof.__typename) calls.removalsWithTypename++
        const i = links.findIndex((l) => l.timestamp === r.timestamp && l.data.target === r.data.target)
        if (i >= 0) links.splice(i, 1)
      }
      for (const a of m.additions) {
        links.push({
          __typename: 'LinkExpression',
          author: 'did:key:alex',
          timestamp: String(++n),
          data: { __typename: 'Link', ...a },
          proof: { __typename: 'ExpressionProof', signature: 'sig', key: 'key' }
        })
      }
    },
    async subjectClasses() {
      return [...classes.keys()]
    },
    async addSubjectClass(className: string, json: string) {
      classes.set(className, json)
    }
  }
}

function fakeManager() {
  const perspectives: ReturnType<typeof fakeProxy>[] = []
  const cbs = new Set<() => void>()
  let connected = true
  let n = 0
  const client = {
    perspective: {
      async all() {
        return perspectives
      },
      async byUUID(uuid: string) {
        return perspectives.find((p) => p.uuid === uuid) ?? null
      },
      async add(name: string) {
        const p = fakeProxy(`uuid-${++n}`, name, () => connected)
        perspectives.push(p)
        return p
      }
    }
  }
  const manager = {
    getClient: () => client,
    isConnected: () => connected,
    setToken() {},
    close() {},
    onConnected(cb: () => void) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    }
  } as unknown as Ad4mClientManager
  return {
    manager,
    perspectives,
    setConnected(v: boolean) {
      connected = v
      if (v) for (const cb of cbs) cb()
    }
  }
}

describe('forge perspective (AD4M adapter)', () => {
  it('creates the perspective once, registers the four classes, and caches the uuid', async () => {
    const fake = fakeManager()
    const dir = tempDir()
    const fp = createForgePerspective({ ad4m: fake.manager, dataDir: dir, log: quietLog() })
    const [g1, g2] = await Promise.all([fp.connect(), fp.connect()])
    expect(g1.id).toBe(g2.id)
    expect(fake.perspectives.map((p) => p.name)).toEqual(['sovereign-forge'])
    expect([...fake.perspectives[0].classes.keys()].sort()).toEqual(['ForgeView', 'RelatedEdge', 'Task', 'WorkStream'])
    expect(JSON.parse(fake.perspectives[0].classes.get('Task')!)).toEqual(FORGE_SHACL_CLASSES.Task)
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'forge-perspective.json'), 'utf-8'))).toEqual({
      perspectiveName: 'sovereign-forge',
      perspectiveUuid: g1.id
    })

    // A second process finds it through the cache, registering nothing twice.
    const again = createForgePerspective({ ad4m: fake.manager, dataDir: dir, log: quietLog() })
    expect((await again.connect()).id).toBe(g1.id)
    expect(fake.perspectives).toHaveLength(1)
  })

  it('finds an existing perspective by name when the cache is missing', async () => {
    const fake = fakeManager()
    await fake.manager.getClient()!.perspective.add('sovereign-forge')
    const g = await createForgePerspective({ ad4m: fake.manager, dataDir: tempDir(), log: quietLog() }).connect()
    expect(g.id).toBe('uuid-1')
    expect(fake.perspectives).toHaveLength(1)
  })

  it('throws while AD4M is not connected', async () => {
    const fake = fakeManager()
    fake.setConnected(false)
    await expect(
      createForgePerspective({ ad4m: fake.manager, dataDir: tempDir(), log: quietLog() }).connect()
    ).rejects.toThrow(/not connected/)
  })

  it('mutates links: removals by pattern (typenames stripped), then additions', async () => {
    const fake = fakeManager()
    const g = await createForgePerspective({ ad4m: fake.manager, dataDir: tempDir(), log: quietLog() }).connect()
    await g.mutate({
      add: [
        { source: 's', predicate: 'p', target: 'one' },
        { source: 's', predicate: 'q', target: 'keep' }
      ]
    })
    await g.mutate({
      removeMatching: [{ source: 's', predicate: 'p' }],
      add: [{ source: 's', predicate: 'p', target: 'two' }]
    })
    const all = await g.all()
    expect(all.sort((a, b) => a.predicate.localeCompare(b.predicate))).toEqual([
      { source: 's', predicate: 'p', target: 'two' },
      { source: 's', predicate: 'q', target: 'keep' }
    ])
    expect(fake.perspectives[0].calls.removalsWithTypename).toBe(0)
    await expect(g.mutate({ removeMatching: [{ source: '' }] })).rejects.toThrow(/source/)
  })

  it('drives a resilient task store end to end, and replays after a reconnect', async () => {
    const fake = fakeManager()
    const dir = tempDir()
    const fp = createForgePerspective({ ad4m: fake.manager, dataDir: dir, log: quietLog() })
    const store = createResilientTaskStore({
      dir,
      connect: () => fp.connect(),
      onReconnect: (cb) => fp.onReconnect(cb),
      snapshotDelayMs: 1,
      retryMs: 60_000,
      log: quietLog()
    })
    await store.settled()
    fake.setConnected(false)
    await store.create({
      id: 'task://a',
      name: 'Ship P0a',
      state: 'pending',
      threadId: null,
      description: null,
      transientState: null,
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: null,
      tags: ['forge'],
      membrane: 'coasys',
      isStream: true
    })
    await until(() => store.status().backend === 'down')
    fake.setConnected(true)
    await until(() => store.status().pending === 0)

    const fresh = createResilientTaskStore({
      dir: tempDir(),
      connect: () => createForgePerspective({ ad4m: fake.manager, dataDir: tempDir(), log: quietLog() }).connect(),
      snapshotDelayMs: 1,
      log: quietLog()
    })
    await fresh.settled()
    expect(await fresh.get('task://a')).toMatchObject({
      name: 'Ship P0a',
      tags: ['forge'],
      membrane: 'coasys',
      isStream: true
    })
    store.dispose()
    fresh.dispose()
  })
})
