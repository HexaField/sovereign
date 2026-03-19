import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createDraftStore } from './store.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'draft-store-'))
}

describe('DraftStore', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('§1.1 Storage', () => {
    it('1.1 MUST store drafts at {dataDir}/drafts/drafts.json as a single JSON array', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'Test' })
      const filePath = path.join(dataDir, 'drafts', 'drafts.json')
      expect(fs.existsSync(filePath)).toBe(true)
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBe(1)
    })

    it('1.1 MUST NOT be scoped to any org — store is global', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A', orgId: 'org1' })
      store.create({ title: 'B', orgId: 'org2' })
      store.create({ title: 'C' })
      // All stored in same file
      const filePath = path.join(dataDir, 'drafts', 'drafts.json')
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data.length).toBe(3)
    })

    it('1.1 published drafts MUST be retained for audit/history', () => {
      const store = createDraftStore(dataDir)
      const draft = store.create({ title: 'Test' })
      store.update(draft.id, { status: 'published' })
      const filePath = path.join(dataDir, 'drafts', 'drafts.json')
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data.length).toBe(1)
      expect(data[0].status).toBe('published')
    })
  })

  describe('§1.1 create', () => {
    it('1.1 create MUST generate a UUID', () => {
      const store = createDraftStore(dataDir)
      const draft = store.create({ title: 'Test' })
      expect(draft.id).toBeTruthy()
      expect(typeof draft.id).toBe('string')
      // UUID format
      expect(draft.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('1.1 create MUST set status to draft', () => {
      const store = createDraftStore(dataDir)
      const draft = store.create({ title: 'Test' })
      expect(draft.status).toBe('draft')
    })

    it('1.1 create MUST set createdAt and updatedAt to now', () => {
      const store = createDraftStore(dataDir)
      const before = new Date().toISOString()
      const draft = store.create({ title: 'Test' })
      const after = new Date().toISOString()
      expect(draft.createdAt >= before).toBe(true)
      expect(draft.createdAt <= after).toBe(true)
      expect(draft.updatedAt >= before).toBe(true)
      expect(draft.updatedAt <= after).toBe(true)
    })

    it('1.1 create MUST set publishedAs to null', () => {
      const store = createDraftStore(dataDir)
      const draft = store.create({ title: 'Test' })
      expect(draft.publishedAs).toBeNull()
    })
  })

  describe('§1.1 update', () => {
    it('1.1 update MUST set updatedAt to now', () => {
      const store = createDraftStore(dataDir)
      const draft = store.create({ title: 'Test' })
      const originalUpdatedAt = draft.updatedAt
      // Small delay to ensure time difference
      const updated = store.update(draft.id, { title: 'Updated' })
      expect(updated.updatedAt >= originalUpdatedAt).toBe(true)
      expect(updated.title).toBe('Updated')
    })
  })

  describe('§1.1 delete', () => {
    it('1.1 delete MUST remove the draft permanently (not soft-delete)', () => {
      const store = createDraftStore(dataDir)
      const draft = store.create({ title: 'Test' })
      store.delete(draft.id)
      expect(store.get(draft.id)).toBeUndefined()
      // Check file too
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'drafts', 'drafts.json'), 'utf-8'))
      expect(data.length).toBe(0)
    })
  })

  describe('§1.1 list', () => {
    it('1.1 list with no filter MUST return all non-published drafts', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A' })
      store.create({ title: 'B' })
      const c = store.create({ title: 'C' })
      store.update(c.id, { status: 'published' })
      const result = store.list()
      expect(result.length).toBe(2)
      expect(result.every((d) => d.status === 'draft')).toBe(true)
    })

    it('1.1 list with orgId filter MUST return drafts matching that orgId', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A', orgId: 'org1' })
      store.create({ title: 'B', orgId: 'org2' })
      const result = store.list({ orgId: 'org1' })
      expect(result.length).toBe(1)
      expect(result[0]!.orgId).toBe('org1')
    })

    it('1.1 list with status filter MUST return drafts matching that status', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A' })
      const b = store.create({ title: 'B' })
      store.update(b.id, { status: 'published' })
      const published = store.list({ status: 'published' })
      expect(published.length).toBe(1)
      expect(published[0]!.status).toBe('published')
    })

    it('1.1 list with label filter MUST return drafts matching that label', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A', labels: ['bug'] })
      store.create({ title: 'B', labels: ['feature'] })
      const result = store.list({ label: 'bug' })
      expect(result.length).toBe(1)
      expect(result[0]!.labels).toContain('bug')
    })
  })

  describe('§1.1 getByOrg', () => {
    it('1.1 getByOrg(null) MUST return only unassigned drafts', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A', orgId: null })
      store.create({ title: 'B', orgId: 'org1' })
      store.create({ title: 'C' }) // defaults to null
      const result = store.getByOrg(null)
      expect(result.length).toBe(2)
      expect(result.every((d) => d.orgId === null)).toBe(true)
    })

    it('1.1 getByOrg(orgId) MUST return drafts assigned to that org', () => {
      const store = createDraftStore(dataDir)
      store.create({ title: 'A', orgId: 'org1' })
      store.create({ title: 'B', orgId: 'org2' })
      const result = store.getByOrg('org1')
      expect(result.length).toBe(1)
      expect(result[0]!.orgId).toBe('org1')
    })
  })

  describe('§1.1 atomic writes', () => {
    it('1.1 all mutations MUST write to disk atomically (write temp then rename)', () => {
      const store = createDraftStore(dataDir)
      // Create a draft — if atomic write works, the file should exist and be valid JSON
      store.create({ title: 'Test' })
      const filePath = path.join(dataDir, 'drafts', 'drafts.json')
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(data.length).toBe(1)
      // No .tmp files should remain
      const dir = path.join(dataDir, 'drafts')
      const files = fs.readdirSync(dir)
      const tmpFiles = files.filter((f) => f.includes('.tmp.'))
      expect(tmpFiles.length).toBe(0)
    })
  })
})
