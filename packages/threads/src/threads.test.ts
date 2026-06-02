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
    expect(t.key).toBe('test-thread')
    expect(t.archived).toBe(false)
    expect(bus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'thread.created' }))
  })

  it('returns existing thread if key matches', () => {
    const tm = createThreadManager(bus, dataDir)
    const t1 = tm.create({ label: 'dup' })
    const t2 = tm.create({ label: 'dup' })
    expect(t1).toBe(t2)
  })

  it('creates thread keyed by entity', () => {
    const tm = createThreadManager(bus, dataDir)
    const entity = { orgId: 'o1', projectId: 'p1', entityType: 'branch' as const, entityRef: 'main' }
    const t = tm.create({ entities: [entity] })
    expect(t.key).toBe('o1/p1/branch:main')
    expect(t.entities).toHaveLength(1)
  })

  it('persists and restores from disk', () => {
    const tm1 = createThreadManager(bus, dataDir)
    tm1.create({ label: 'persisted' })

    const bus2 = createMockBus()
    const tm2 = createThreadManager(bus2, dataDir)
    const t = tm2.get('persisted')
    expect(t).toBeDefined()
    expect(t!.key).toBe('persisted')
  })

  describe('list with filters', () => {
    it('filters by workspaceId — matches entity orgId', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'global' }) // no entities, no workspace → global
      tm.create({ entities: [{ orgId: 'o1', projectId: 'p1', entityType: 'branch', entityRef: 'a' }] })
      tm.create({ entities: [{ orgId: 'o2', projectId: 'p2', entityType: 'branch', entityRef: 'b' }] })

      const filtered = tm.list({ workspaceId: 'o1' })
      expect(filtered).toHaveLength(1)
      expect(filtered.map((t) => t.key)).toContain('o1/p1/branch:a')
    })

    it('filters by workspaceId — scoped threads only show in their workspace', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'ws1-thread', workspaceIds: ['ws1'] })
      tm.create({ label: 'ws2-thread', workspaceIds: ['ws2'] })
      tm.create({ label: 'global-thread' }) // no workspace
      tm.create({ label: 'explicit-global', workspaceIds: [] })

      const ws1 = tm.list({ workspaceId: 'ws1' })
      expect(ws1.map((t) => t.key)).toContain('ws1-thread')
      // Global threads are not implicitly included when filtering by workspace
      expect(ws1.map((t) => t.key)).not.toContain('global-thread')
      expect(ws1.map((t) => t.key)).not.toContain('explicit-global')
      expect(ws1.map((t) => t.key)).not.toContain('ws2-thread')

      const ws2 = tm.list({ workspaceId: 'ws2' })
      expect(ws2.map((t) => t.key)).toContain('ws2-thread')
      expect(ws2.map((t) => t.key)).not.toContain('global-thread')
      expect(ws2.map((t) => t.key)).not.toContain('ws1-thread')

      // `_global` workspaceId filter selects threads with NO workspace and NO entities
      const global = tm.list({ workspaceId: '_global' }).map((t) => t.key)
      expect(global).toContain('global-thread')
      expect(global).toContain('explicit-global')
      expect(global).not.toContain('ws1-thread')
    })

    it('filters by projectId', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ entities: [{ orgId: 'o1', projectId: 'p1', entityType: 'branch', entityRef: 'a' }] })
      tm.create({ entities: [{ orgId: 'o1', projectId: 'p2', entityType: 'branch', entityRef: 'b' }] })

      const filtered = tm.list({ projectId: 'p1' })
      expect(filtered).toHaveLength(1)
    })

    it('filters by active (non-archived)', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'active' })
      tm.create({ label: 'to-archive' })
      tm.delete('to-archive')

      const active = tm.list({ active: true })
      expect(active).toHaveLength(1)
      expect(active[0].key).toBe('active')
    })

    it('filters by archived flag', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'a' })
      tm.create({ label: 'b' })
      tm.delete('b')

      expect(tm.list({ archived: true })).toHaveLength(1)
      expect(tm.list({ archived: false })).toHaveLength(1)
    })
  })

  describe('entity management', () => {
    it('adds and removes entities', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'ent-test' })
      const entity = { orgId: 'o', projectId: 'p', entityType: 'issue' as const, entityRef: '42' }

      tm.addEntity('ent-test', entity)
      expect(tm.getEntities('ent-test')).toHaveLength(1)

      // Duplicate add is idempotent
      tm.addEntity('ent-test', entity)
      expect(tm.getEntities('ent-test')).toHaveLength(1)

      tm.removeEntity('ent-test', 'issue', '42')
      expect(tm.getEntities('ent-test')).toHaveLength(0)
    })

    it('getThreadsForEntity finds matching threads', () => {
      const tm = createThreadManager(bus, dataDir)
      const entity = { orgId: 'o', projectId: 'p', entityType: 'branch' as const, entityRef: 'feat' }
      tm.create({ entities: [entity] })
      tm.create({ label: 'other' })

      const found = tm.getThreadsForEntity(entity)
      expect(found).toHaveLength(1)
      expect(found[0].key).toBe('o/p/branch:feat')
    })
  })

  describe('events', () => {
    it('stores and retrieves thread events', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'evt' })
      tm.addEvent('evt', { type: 'message', timestamp: 1000, data: { text: 'hello' } } as any)
      tm.addEvent('evt', { type: 'message', timestamp: 2000, data: { text: 'world' } } as any)

      expect(tm.getEvents('evt')).toHaveLength(2)
      expect(tm.getEvents('evt', { since: 1500 })).toHaveLength(1)
      expect(tm.getEvents('evt', { limit: 1 })).toHaveLength(1)
      expect(tm.getEvents('evt', { offset: 1 })).toHaveLength(1)
    })
  })

  describe('auto-creation from bus events', () => {
    it('creates thread on worktree.created', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('worktree.created', { orgId: 'o', projectId: 'p', branch: 'feature' })
      expect(tm.get('o/p/branch:feature')).toBeDefined()
    })

    it('creates thread on issue.created', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('issue.created', { orgId: 'o', projectId: 'p', issueId: '99' })
      expect(tm.get('o/p/issue:99')).toBeDefined()
    })

    it('creates thread on review.created', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('review.created', { orgId: 'o', projectId: 'p', prId: '7' })
      expect(tm.get('o/p/pr:7')).toBeDefined()
    })

    it('does not duplicate auto-created threads', () => {
      const tm = createThreadManager(bus, dataDir)
      bus._emit('worktree.created', { orgId: 'o', projectId: 'p', branch: 'f' })
      bus._emit('worktree.created', { orgId: 'o', projectId: 'p', branch: 'f' })
      expect(tm.list().filter((t) => t.key === 'o/p/branch:f')).toHaveLength(1)
    })
  })

  it('delete marks as archived', () => {
    const tm = createThreadManager(bus, dataDir)
    tm.create({ label: 'del-me' })
    expect(tm.delete('del-me')).toBe(true)
    expect(tm.get('del-me')?.archived).toBe(true)
    expect(tm.delete('nonexistent')).toBe(false)
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
      const updated = tm.update('x', { membraneId: 'personal', workspaceIds: ['hexafield'] })
      expect(updated?.membraneId).toBe('personal')
      expect(updated?.workspaceIds).toEqual(['hexafield'])
    })

    it('persists membraneId / workspaceIds across reload', () => {
      const tm1 = createThreadManager(bus, dataDir)
      tm1.create({ label: 'sovereign', membraneId: 'personal', workspaceIds: ['hexafield'] })
      const tm2 = createThreadManager(bus, dataDir)
      const t = tm2.get('sovereign')
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
      expect(persisted.version).toBe(1)
      expect(persisted.threads).toHaveLength(3)

      // Field-level: orgId is gone, membraneId + workspaceIds derived correctly
      const main = tm.get('main')
      expect(main?.membraneId).toBe('personal')
      expect(main?.workspaceIds).toEqual([]) // _global → empty
      expect((main as any)?.orgId).toBeUndefined()

      const ad4m = tm.get('ad4m')
      expect(ad4m?.membraneId).toBe('adam')
      expect(ad4m?.workspaceIds).toEqual(['coasys'])

      const sov = tm.get('sovereign')
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
      const t = tm.get('orphan')
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
          evt: [{ threadKey: 'evt', event: { foo: 1 }, entityBinding: {} as any, timestamp: 100 }]
        }
      })
      const tm = createThreadManager(bus, dataDir)
      expect(tm.getEvents('evt')).toHaveLength(1)
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
      expect(tm.get('fresh')).toBeDefined()
      expect(tm.get('legacy')).toBeUndefined()
    })
  })
})
