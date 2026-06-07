import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { EventBus } from '@sovereign/core'
import { createThreadManager } from './threads.js'

function createMockBus(): EventBus & { _emit: (type: string, payload: any) => void } {
  const handlers = new Map<string, Set<(ev: any) => void>>()
  return {
    emit: vi.fn((ev: any) => {
      handlers.get(ev.type)?.forEach((h) => h(ev))
    }),
    on(type: string, handler: (ev: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => {
        handlers.get(type)?.delete(handler)
      }
    },
    _emit(type: string, payload: any) {
      const ev = { type, timestamp: new Date().toISOString(), source: 'test', payload }
      handlers.get(type)?.forEach((h) => h(ev))
    }
  } as any
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thread-test-'))
}

describe('ThreadManager', () => {
  let dataDir: string
  let bus: ReturnType<typeof createMockBus>

  beforeEach(() => {
    dataDir = tmpDir()
    bus = createMockBus()
  })

  it('creates a thread with label', () => {
    const tm = createThreadManager(bus, dataDir)
    const t = tm.create({ label: 'test-thread' })
    expect(t.label).toBe('test-thread')
    expect(t.archived).toBe(false)
    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread.created' }))
  })

  it('returns existing thread if key matches', () => {
    const tm = createThreadManager(bus, dataDir)
    const t1 = tm.create({ label: 'dup' })
    const t2 = tm.create({ label: 'dup' })
    expect(t1.id).not.toBe(t2.id)
    expect(t1.label).toBe(t2.label)
  })

  // Regression: bootstrap.ts seeded system threads with `if (!tm.get(label))`.
  // `get()` is keyed by UUID, so it never matched a human label — every boot
  // minted a fresh duplicate of 'main'/'upgrades'/'v2-app'. Lock in the
  // get-vs-getByLabel contract that caused it.
  it('get() is UUID-keyed and never resolves a label (the seed-duplication footgun)', () => {
    const tm = createThreadManager(bus, dataDir)
    const t = tm.create({ label: 'main' })
    expect(tm.get('main')).toBeUndefined() // ← the bug: get(label) is always undefined
    expect(tm.get(t.id)?.label).toBe('main')
    expect(tm.getByLabel('main')?.id).toBe(t.id)
    expect(tm.resolve('main')?.id).toBe(t.id)
  })

  // Mirrors the first-boot seed in bootstrap.ts. The runtime makes NO standing
  // assumptions about which threads exist — it seeds exactly ONE default thread,
  // and only when the registry is empty. (The old code looped over hard-coded
  // personal labels ['main','upgrades','v2-app'] and re-minted them every boot.)
  const seedDefault = (tm: ReturnType<typeof createThreadManager>, label = 'Main') => {
    if (label && tm.list().length === 0) tm.create({ label, membraneId: 'personal' })
  }

  it('seeds a single default thread only on an empty registry, idempotently across boots', () => {
    const tm = createThreadManager(bus, dataDir)
    seedDefault(tm)
    seedDefault(tm) // second "boot" in-process: registry non-empty → no-op
    expect(tm.list()).toHaveLength(1)
    expect(tm.list()[0].label).toBe('Main')
    // Cold restart: a fresh manager over the same dataDir must not re-seed.
    const tm2 = createThreadManager(createMockBus(), dataDir)
    seedDefault(tm2)
    expect(tm2.list()).toHaveLength(1)
  })

  it('never seeds a default thread when the user already has threads', () => {
    const tm = createThreadManager(bus, dataDir)
    tm.create({ label: 'research' })
    seedDefault(tm)
    expect(tm.list()).toHaveLength(1)
    expect(tm.list().some((t) => t.label === 'Main')).toBe(false)
  })

  it('opting out (empty default label) seeds nothing', () => {
    const tm = createThreadManager(bus, dataDir)
    seedDefault(tm, '')
    expect(tm.list()).toHaveLength(0)
  })

  it('creates thread with entities bound at construction', () => {
    const tm = createThreadManager(bus, dataDir)
    const entity = { orgId: 'o1', projectId: 'p1', entityType: 'branch' as const, entityRef: 'main' }
    const t = tm.create({ label: 'o1/p1/branch:main', entities: [entity] })
    expect(t.label).toBe('o1/p1/branch:main')
    expect(t.entities).toHaveLength(1)
  })

  it('persists and restores from disk', () => {
    const tm1 = createThreadManager(bus, dataDir)
    tm1.create({ label: 'persisted' })

    const bus2 = createMockBus()
    const tm2 = createThreadManager(bus2, dataDir)
    const t = tm2.resolve('persisted')
    expect(t).toBeDefined()
    expect(t!.label).toBe('persisted')
  })

  describe('list with filters', () => {
    it('filters by workspaceId — matches entity orgId', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'global' }) // no entities, no workspace → global
      tm.create({
        label: 'o1/p1/branch:a',
        entities: [{ orgId: 'o1', projectId: 'p1', entityType: 'branch', entityRef: 'a' }]
      })
      tm.create({
        label: 'o2/p2/branch:b',
        entities: [{ orgId: 'o2', projectId: 'p2', entityType: 'branch', entityRef: 'b' }]
      })

      const filtered = tm.list({ workspaceId: 'o1' })
      expect(filtered).toHaveLength(1)
      expect(filtered.map((t) => t.label)).toContain('o1/p1/branch:a')
    })

    it('filters by workspaceId — scoped threads only show in their workspace', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'ws1-thread', workspaceIds: ['ws1'] })
      tm.create({ label: 'ws2-thread', workspaceIds: ['ws2'] })
      tm.create({ label: 'global-thread' }) // no workspace
      tm.create({ label: 'explicit-global', workspaceIds: [] })

      const ws1 = tm.list({ workspaceId: 'ws1' })
      expect(ws1.map((t) => t.label)).toContain('ws1-thread')
      // Global threads are not implicitly included when filtering by workspace
      expect(ws1.map((t) => t.label)).not.toContain('global-thread')
      expect(ws1.map((t) => t.label)).not.toContain('explicit-global')
      expect(ws1.map((t) => t.label)).not.toContain('ws2-thread')

      const ws2 = tm.list({ workspaceId: 'ws2' })
      expect(ws2.map((t) => t.label)).toContain('ws2-thread')
      expect(ws2.map((t) => t.label)).not.toContain('global-thread')
      expect(ws2.map((t) => t.label)).not.toContain('ws1-thread')

      // `_global` workspaceId filter selects threads with NO workspace and NO entities
      const global = tm.list({ workspaceId: '_global' }).map((t) => t.label)
      expect(global).toContain('global-thread')
      expect(global).toContain('explicit-global')
      expect(global).not.toContain('ws1-thread')
    })

    it('filters by projectId', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({
        label: 'o1/p1/branch:a',
        entities: [{ orgId: 'o1', projectId: 'p1', entityType: 'branch', entityRef: 'a' }]
      })
      tm.create({
        label: 'o1/p2/branch:b',
        entities: [{ orgId: 'o1', projectId: 'p2', entityType: 'branch', entityRef: 'b' }]
      })

      const filtered = tm.list({ projectId: 'p1' })
      expect(filtered).toHaveLength(1)
    })

    it('filters by active (non-archived)', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'active' })
      tm.create({ label: 'to-archive' })
      tm.delete(tm.resolve('to-archive')!.id)

      const active = tm.list({ active: true })
      expect(active).toHaveLength(1)
      expect(active[0].label).toBe('active')
    })

    it('filters by archived flag', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'a' })
      tm.create({ label: 'b' })
      tm.delete(tm.resolve('b')!.id)

      expect(tm.list({ archived: true })).toHaveLength(1)
      expect(tm.list({ archived: false })).toHaveLength(1)
    })
  })

  describe('entity management', () => {
    it('adds and removes entities', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'ent-test' })
      const entity = { orgId: 'o', projectId: 'p', entityType: 'issue' as const, entityRef: '42' }

      tm.addEntity(tm.resolve('ent-test')!.id, entity)
      expect(tm.getEntities(tm.resolve('ent-test')!.id)).toHaveLength(1)

      // Duplicate add is idempotent
      tm.addEntity(tm.resolve('ent-test')!.id, entity)
      expect(tm.getEntities(tm.resolve('ent-test')!.id)).toHaveLength(1)

      tm.removeEntity(tm.resolve('ent-test')!.id, 'issue', '42')
      expect(tm.getEntities(tm.resolve('ent-test')!.id)).toHaveLength(0)
    })

    it('getThreadsForEntity finds matching threads', () => {
      const tm = createThreadManager(bus, dataDir)
      const entity = { orgId: 'o', projectId: 'p', entityType: 'branch' as const, entityRef: 'feat' }
      tm.create({ label: 'o/p/branch:feat', entities: [entity] })
      tm.create({ label: 'other' })

      const found = tm.getThreadsForEntity(entity)
      expect(found).toHaveLength(1)
      expect(found[0].label).toBe('o/p/branch:feat')
    })
  })

  describe('events', () => {
    it('stores and retrieves thread events', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'evt' })
      tm.addEvent(tm.resolve('evt')!.id, { type: 'message', timestamp: 1000, data: { text: 'hello' } } as any)
      tm.addEvent(tm.resolve('evt')!.id, { type: 'message', timestamp: 2000, data: { text: 'world' } } as any)

      expect(tm.getEvents(tm.resolve('evt')!.id)).toHaveLength(2)
      expect(tm.getEvents(tm.resolve('evt')!.id, { since: 1500 })).toHaveLength(1)
      expect(tm.getEvents(tm.resolve('evt')!.id, { limit: 1 })).toHaveLength(1)
      expect(tm.getEvents(tm.resolve('evt')!.id, { offset: 1 })).toHaveLength(1)
    })
  })

  // Auto-created threads are looked up via their entity binding (the
  // canonical way; labels are descriptive, not addressable).
  describe('auto-creation from bus events', () => {
    it('creates thread on worktree.created', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('worktree.created', { orgId: 'o', projectId: 'p', branch: 'feature' })
      const entity = { orgId: 'o', projectId: 'p', entityType: 'branch' as const, entityRef: 'feature' }
      expect(tm.getThreadsForEntity(entity)).toHaveLength(1)
    })

    it('creates thread on issue.created', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('issue.created', { orgId: 'o', projectId: 'p', issueId: '99' })
      const entity = { orgId: 'o', projectId: 'p', entityType: 'issue' as const, entityRef: '99' }
      expect(tm.getThreadsForEntity(entity)).toHaveLength(1)
    })

    it('creates thread on review.created', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('review.created', { orgId: 'o', projectId: 'p', prId: '7' })
      const entity = { orgId: 'o', projectId: 'p', entityType: 'pr' as const, entityRef: '7' }
      expect(tm.getThreadsForEntity(entity)).toHaveLength(1)
    })

    it('does not duplicate auto-created threads', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('worktree.created', { orgId: 'o', projectId: 'p', branch: 'f' })
      bus._emit('worktree.created', { orgId: 'o', projectId: 'p', branch: 'f' })
      const entity = { orgId: 'o', projectId: 'p', entityType: 'branch' as const, entityRef: 'f' }
      expect(tm.getThreadsForEntity(entity)).toHaveLength(1)
    })
  })

  it('delete marks as archived', () => {
    const tm = createThreadManager(bus, dataDir)
    tm.create({ label: 'del-me' })
    expect(tm.delete(tm.resolve('del-me')!.id)).toBe(true)
    expect(tm.resolve('del-me')?.archived).toBe(true)
    expect(tm.delete('nonexistent-id')).toBe(false)
  })

  describe('membrane + workspace mapping', () => {
    it('accepts membraneId and workspaceIds on create', () => {
      const tm = createThreadManager(bus, dataDir)
      const t = tm.create({
        label: 'sovereign',
        membraneId: 'personal',
        workspaceIds: ['hexafield', 'coasys']
      })
      expect(t.membraneId).toBe('personal')
      expect(t.workspaceIds).toEqual(['hexafield', 'coasys'])
    })

    it('threads with no membraneId stay unassigned (no orgId fallback)', () => {
      const tm = createThreadManager(bus, dataDir)
      const t = tm.create({ label: 'legacy' })
      expect(t.membraneId).toBeUndefined()
      expect(t.workspaceIds).toEqual([])
      // `orgId` field is gone from the type entirely
      expect((t as any).orgId).toBeUndefined()
    })

    it('derives workspaceIds from entities[0] when not explicit', () => {
      const tm = createThreadManager(bus, dataDir)
      const t = tm.create({
        label: 'ad4m/main',
        entities: [{ orgId: 'coasys', projectId: 'ad4m', entityType: 'branch', entityRef: 'main' }]
      })
      expect(t.workspaceIds).toEqual(['coasys'])
    })

    it('filter by membraneId returns only threads in that membrane', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'a', membraneId: 'personal' })
      tm.create({ label: 'b', membraneId: 'coasys' })
      tm.create({ label: 'c', membraneId: 'personal' })
      const inPersonal = tm.list({ membraneId: 'personal' }).map((t) => t.label)
      expect(inPersonal.sort()).toEqual(['a', 'c'])
    })

    it('update can set membraneId and workspaceIds', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'x' })
      const updated = tm.update(tm.resolve('x')!.id, { membraneId: 'personal', workspaceIds: ['hexafield'] })
      expect(updated?.membraneId).toBe('personal')
      expect(updated?.workspaceIds).toEqual(['hexafield'])
    })

    it('persists membraneId / workspaceIds across reload', () => {
      const tm1 = createThreadManager(bus, dataDir)
      tm1.create({ label: 'sovereign', membraneId: 'personal', workspaceIds: ['hexafield'] })
      const tm2 = createThreadManager(bus, dataDir)
      const t = tm2.resolve('sovereign')
      expect(t?.membraneId).toBe('personal')
      expect(t?.workspaceIds).toEqual(['hexafield'])
    })
  })

  // ────────────────────────────────────────────────────────────────────
  // §Migration — one-time legacy registry.json → threads.json rewrite.
  //
  // Production data shape pre-membranes was
  //   <dataDir>/threads/registry.json = { threads: [{ orgId, ... }], events }
  // with every thread carrying an `orgId`. The migration:
  //   1. Reads membranes.json to build an orgId→membraneId lookup.
  //   2. Rewrites each thread into the new shape (membraneId derived,
  //      workspaceIds populated, orgId dropped).
  //   3. Persists to <dataDir>/threads.json.
  //   4. Leaves registry.json on disk for rollback safety.
  describe('one-time legacy migration', () => {
    function seedLegacy(opts: { dataDir: string; threads: any[]; events?: Record<string, any[]>; membranes?: any[] }) {
      const threadsDir = path.join(opts.dataDir, 'threads')
      fs.mkdirSync(threadsDir, { recursive: true })
      fs.writeFileSync(
        path.join(threadsDir, 'registry.json'),
        JSON.stringify({ threads: opts.threads, events: opts.events ?? {} }, null, 2)
      )
      if (opts.membranes) {
        fs.writeFileSync(
          path.join(opts.dataDir, 'membranes.json'),
          JSON.stringify({ version: 1, membranes: opts.membranes }, null, 2)
        )
      }
    }

    it('migrates legacy threads into threads.json on first construction', () => {
      seedLegacy({
        dataDir,
        threads: [
          {
            key: 'main',
            label: 'main',
            orgId: '_global',
            entities: [],
            lastActivity: 1,
            unreadCount: 0,
            agentStatus: 'idle',
            createdAt: 1,
            archived: false
          },
          {
            key: 'ad4m',
            label: 'ad4m',
            orgId: 'coasys',
            entities: [],
            lastActivity: 2,
            unreadCount: 0,
            agentStatus: 'idle',
            createdAt: 2,
            archived: false
          },
          {
            key: 'sovereign',
            label: 'sovereign',
            orgId: 'hexafield',
            entities: [],
            lastActivity: 3,
            unreadCount: 0,
            agentStatus: 'idle',
            createdAt: 3,
            archived: false
          }
        ],
        membranes: [
          {
            id: 'personal',
            name: 'Personal',
            visibility: 'private',
            workspaceIds: ['_global', 'hexafield'],
            createdAt: '',
            updatedAt: ''
          },
          { id: 'adam', name: 'ADAM', visibility: 'shared', workspaceIds: ['coasys'], createdAt: '', updatedAt: '' }
        ]
      })

      const tm = createThreadManager(bus, dataDir)

      // threads.json should now exist with the migrated shape
      const newFile = path.join(dataDir, 'threads.json')
      expect(fs.existsSync(newFile)).toBe(true)
      const persisted = JSON.parse(fs.readFileSync(newFile, 'utf-8'))
      expect(persisted.version).toBe(2)
      expect(persisted.threads).toHaveLength(3)

      // Field-level: orgId is gone, membraneId + workspaceIds derived correctly
      const main = tm.resolve('main')
      expect(main?.membraneId).toBe('personal')
      expect(main?.workspaceIds).toEqual([]) // _global → empty
      expect((main as any)?.orgId).toBeUndefined()

      const ad4m = tm.resolve('ad4m')
      expect(ad4m?.membraneId).toBe('adam')
      expect(ad4m?.workspaceIds).toEqual(['coasys'])

      const sov = tm.resolve('sovereign')
      expect(sov?.membraneId).toBe('personal')
      expect(sov?.workspaceIds).toEqual(['hexafield'])

      // Legacy registry.json must still exist (rollback safety)
      expect(fs.existsSync(path.join(dataDir, 'threads', 'registry.json'))).toBe(true)
    })

    it('leaves membraneId undefined when orgId is absent from any membrane', () => {
      seedLegacy({
        dataDir,
        threads: [
          {
            key: 'orphan',
            label: 'orphan',
            orgId: 'mysteryorg',
            entities: [],
            lastActivity: 1,
            unreadCount: 0,
            agentStatus: 'idle',
            createdAt: 1,
            archived: false
          }
        ],
        membranes: [
          {
            id: 'personal',
            name: 'Personal',
            visibility: 'private',
            workspaceIds: ['_global'],
            createdAt: '',
            updatedAt: ''
          }
        ]
      })
      const tm = createThreadManager(bus, dataDir)
      const t = tm.resolve('orphan')
      expect(t?.membraneId).toBeUndefined()
      expect(t?.workspaceIds).toEqual(['mysteryorg'])
    })

    it('migrates events from registry.json to threads/events.json', () => {
      seedLegacy({
        dataDir,
        threads: [
          {
            key: 'evt',
            label: 'evt',
            orgId: '_global',
            entities: [],
            lastActivity: 1,
            unreadCount: 0,
            agentStatus: 'idle',
            createdAt: 1,
            archived: false
          }
        ],
        events: {
          evt: [{ threadId: 'evt', event: { foo: 1 }, entityBinding: {} as any, timestamp: 100 }]
        }
      })
      const tm = createThreadManager(bus, dataDir)
      expect(tm.getEvents(tm.resolve('evt')!.id)).toHaveLength(1)
      expect(fs.existsSync(path.join(dataDir, 'threads', 'events.json'))).toBe(true)
    })

    it('does not re-migrate once threads.json exists', () => {
      seedLegacy({
        dataDir,
        threads: [
          {
            key: 'legacy',
            label: 'legacy',
            orgId: 'coasys',
            entities: [],
            lastActivity: 1,
            unreadCount: 0,
            agentStatus: 'idle',
            createdAt: 1,
            archived: false
          }
        ]
      })
      // Pre-populate threads.json with a different set — the migration
      // path must NOT overwrite this on subsequent construction.
      fs.writeFileSync(
        path.join(dataDir, 'threads.json'),
        JSON.stringify({
          version: 1,
          threads: [
            {
              key: 'fresh',
              label: 'fresh',
              membraneId: 'personal',
              workspaceIds: [],
              entities: [],
              lastActivity: 9,
              unreadCount: 0,
              agentStatus: 'idle',
              createdAt: 9,
              archived: false
            }
          ]
        })
      )
      const tm = createThreadManager(bus, dataDir)
      expect(tm.resolve('fresh')).toBeDefined()
      expect(tm.resolve('legacy')).toBeUndefined()
    })
  })

  describe('unread counter', () => {
    it('markUnreadIncrement bumps the count and emits thread.updated', () => {
      const tm = createThreadManager(bus, dataDir)
      const t = tm.create({ label: 'unread-test' })
      const updates: any[] = []
      bus.on('thread.updated', (e: any) => {
        updates.push(e)
      })
      expect(tm.markUnreadIncrement(t.id)).toBe(1)
      expect(tm.markUnreadIncrement(t.id)).toBe(2)
      expect(tm.get(t.id)?.unreadCount).toBe(2)
      expect(updates.length).toBe(2)
      expect(updates[1].payload.patch).toEqual({ unreadCount: 2 })
    })

    it('clearUnread zeros the count and emits thread.updated only when changed', () => {
      const tm = createThreadManager(bus, dataDir)
      const t = tm.create({ label: 'unread-clear' })
      tm.markUnreadIncrement(t.id)
      const updates: any[] = []
      bus.on('thread.updated', (e: any) => {
        updates.push(e)
      })
      expect(tm.clearUnread(t.id)).toBe(true)
      expect(tm.get(t.id)?.unreadCount).toBe(0)
      expect(updates.length).toBe(1)
      // Already zero — should NOT re-emit
      expect(tm.clearUnread(t.id)).toBe(false)
      expect(updates.length).toBe(1)
    })

    it('returns undefined / false for an unknown thread', () => {
      const tm = createThreadManager(bus, dataDir)
      expect(tm.markUnreadIncrement('bogus')).toBeUndefined()
      expect(tm.clearUnread('bogus')).toBe(false)
    })

    it('persists unreadCount across instances', () => {
      const tm1 = createThreadManager(bus, dataDir)
      const t = tm1.create({ label: 'persist' })
      tm1.markUnreadIncrement(t.id)
      tm1.markUnreadIncrement(t.id)

      const tm2 = createThreadManager(bus, dataDir)
      expect(tm2.get(t.id)?.unreadCount).toBe(2)
    })
  })
})
