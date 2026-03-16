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
    it('filters by orgId — includes threads with no orgId as global', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'global' }) // no entities, no orgId → global
      tm.create({ entities: [{ orgId: 'o1', projectId: 'p1', entityType: 'branch', entityRef: 'a' }] })
      tm.create({ entities: [{ orgId: 'o2', projectId: 'p2', entityType: 'branch', entityRef: 'b' }] })

      // All three have no orgId, so all are global and show for any orgId filter
      // Plus entity-based matching: o1 entity matches o1 filter
      const filtered = tm.list({ orgId: 'o1' })
      expect(filtered).toHaveLength(3) // all global (no orgId set)
      expect(filtered.map((t) => t.key)).toContain('global')
    })

    it('filters by orgId — scoped threads only show in their workspace', () => {
      const tm = createThreadManager(bus, dataDir)
      tm.create({ label: 'ws1-thread', orgId: 'ws1' })
      tm.create({ label: 'ws2-thread', orgId: 'ws2' })
      tm.create({ label: 'global-thread' }) // no orgId → global
      tm.create({ label: 'explicit-global', orgId: '_global' })

      const ws1 = tm.list({ orgId: 'ws1' })
      expect(ws1.map((t) => t.key)).toContain('ws1-thread')
      expect(ws1.map((t) => t.key)).toContain('global-thread')
      expect(ws1.map((t) => t.key)).toContain('explicit-global')
      expect(ws1.map((t) => t.key)).not.toContain('ws2-thread')

      const ws2 = tm.list({ orgId: 'ws2' })
      expect(ws2.map((t) => t.key)).toContain('ws2-thread')
      expect(ws2.map((t) => t.key)).toContain('global-thread')
      expect(ws2.map((t) => t.key)).not.toContain('ws1-thread')
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
})
