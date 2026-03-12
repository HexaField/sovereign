import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { EventBus, BusEvent, BusHandler, Unsubscribe } from '@template/core'
import { createChangeSetManager } from './changeset.js'

let tmpDir: string
let events: BusEvent[]
let bus: EventBus

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-test-'))
  events = []
  bus = {
    emit(event: BusEvent) {
      events.push(event)
    },
    on(_pattern: string, _handler: BusHandler): Unsubscribe {
      return () => {}
    },
    once(_pattern: string, _handler: BusHandler): Unsubscribe {
      return () => {}
    },
    async *replay() {},
    history() {
      return []
    }
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const makeData = (overrides: Record<string, unknown> = {}) => ({
  orgId: 'org1',
  projectId: 'proj1',
  baseBranch: 'main',
  headBranch: 'feature',
  title: 'Test CS',
  description: 'A test change set',
  ...overrides
})

describe('ChangeSetManager', () => {
  describe('create change set', () => {
    it('creates a change set with unique id', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      expect(cs.id).toBeTruthy()
      expect(cs.title).toBe('Test CS')
    })

    it('sets initial status to "open"', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      expect(cs.status).toBe('open')
    })

    it('sets createdAt and updatedAt timestamps', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      expect(cs.createdAt).toBeTruthy()
      expect(cs.updatedAt).toBeTruthy()
    })

    it('assigns a unique id', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs1 = await mgr.createChangeSet(makeData())
      const cs2 = await mgr.createChangeSet(makeData({ title: 'Second' }))
      expect(cs1.id).not.toBe(cs2.id)
    })
  })

  describe('get change set', () => {
    it('returns change set by id', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      expect(mgr.getChangeSet(cs.id)).toEqual(cs)
    })

    it('returns undefined for non-existent id', () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      expect(mgr.getChangeSet('nonexistent')).toBeUndefined()
    })
  })

  describe('list change sets', () => {
    it('lists all change sets', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      await mgr.createChangeSet(makeData())
      await mgr.createChangeSet(makeData({ title: 'Second' }))
      expect(mgr.listChangeSets()).toHaveLength(2)
    })

    it('filters by orgId', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      await mgr.createChangeSet(makeData({ orgId: 'org1' }))
      await mgr.createChangeSet(makeData({ orgId: 'org2' }))
      expect(mgr.listChangeSets({ orgId: 'org1' })).toHaveLength(1)
    })

    it('filters by status', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      mgr.updateChangeSet(cs.id, { status: 'closed' })
      await mgr.createChangeSet(makeData({ title: 'open' }))
      expect(mgr.listChangeSets({ status: 'open' })).toHaveLength(1)
    })

    it('filters by orgId and status combined', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      await mgr.createChangeSet(makeData({ orgId: 'org1' }))
      const cs2 = await mgr.createChangeSet(makeData({ orgId: 'org1', title: 'closed' }))
      mgr.updateChangeSet(cs2.id, { status: 'closed' })
      await mgr.createChangeSet(makeData({ orgId: 'org2' }))
      expect(mgr.listChangeSets({ orgId: 'org1', status: 'open' })).toHaveLength(1)
    })
  })

  describe('update change set', () => {
    it('updates status', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      const updated = mgr.updateChangeSet(cs.id, { status: 'reviewing' })
      expect(updated.status).toBe('reviewing')
    })

    it('updates title and description', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      const updated = mgr.updateChangeSet(cs.id, { title: 'New Title', description: 'New desc' })
      expect(updated.title).toBe('New Title')
      expect(updated.description).toBe('New desc')
    })

    it('updates updatedAt timestamp', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      const before = cs.updatedAt
      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 10))
      const updated = mgr.updateChangeSet(cs.id, { title: 'Changed' })
      expect(updated.updatedAt).not.toBe(before)
    })

    it('returns the updated change set', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      const updated = mgr.updateChangeSet(cs.id, { title: 'X' })
      expect(updated.id).toBe(cs.id)
      expect(updated.title).toBe('X')
    })
  })

  describe('delete change set', () => {
    it('removes change set by id', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      mgr.deleteChangeSet(cs.id)
      expect(mgr.getChangeSet(cs.id)).toBeUndefined()
    })

    it('removes persisted JSON file', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      const file = path.join(tmpDir, 'reviews', `${cs.id}.json`)
      expect(fs.existsSync(file)).toBe(true)
      mgr.deleteChangeSet(cs.id)
      expect(fs.existsSync(file)).toBe(false)
    })
  })

  describe('persistence', () => {
    it('persists change sets as JSON files', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      const file = path.join(tmpDir, 'reviews', `${cs.id}.json`)
      expect(fs.existsSync(file)).toBe(true)
      const stored = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(stored.id).toBe(cs.id)
    })

    it('loads persisted change sets on startup', async () => {
      const mgr1 = createChangeSetManager(bus, tmpDir)
      const cs = await mgr1.createChangeSet(makeData())

      // Create new manager from same dir
      const mgr2 = createChangeSetManager(bus, tmpDir)
      expect(mgr2.getChangeSet(cs.id)).toBeDefined()
      expect(mgr2.getChangeSet(cs.id)!.title).toBe(cs.title)
    })

    it('survives restart', async () => {
      const mgr1 = createChangeSetManager(bus, tmpDir)
      const cs = await mgr1.createChangeSet(makeData())
      mgr1.updateChangeSet(cs.id, { status: 'reviewing' })

      const mgr2 = createChangeSetManager(bus, tmpDir)
      expect(mgr2.getChangeSet(cs.id)!.status).toBe('reviewing')
    })
  })

  describe('bus events', () => {
    it('emits changeset.created on create', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      await mgr.createChangeSet(makeData())
      expect(events.some((e) => e.type === 'changeset.created')).toBe(true)
    })

    it('emits changeset.updated on update', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      events.length = 0
      mgr.updateChangeSet(cs.id, { title: 'Changed' })
      expect(events.some((e) => e.type === 'changeset.updated')).toBe(true)
    })

    it('emits changeset.closed when status set to closed', async () => {
      const mgr = createChangeSetManager(bus, tmpDir)
      const cs = await mgr.createChangeSet(makeData())
      events.length = 0
      mgr.updateChangeSet(cs.id, { status: 'closed' })
      expect(events.some((e) => e.type === 'changeset.closed')).toBe(true)
    })
  })
})
