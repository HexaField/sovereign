import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createDraftRouter } from './routes.js'
import { createDraftStore } from './store.js'
import type { Draft } from './types.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'draft-routes-'))
}

function createMockBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any
}

function createMockIssueTracker() {
  return {
    create: vi.fn().mockResolvedValue({
      id: '42',
      title: 'Test',
      body: '',
      state: 'open',
      labels: [],
      assignees: [],
      orgId: 'org1',
      projectId: 'proj1',
      remote: 'origin',
      provider: 'github',
      kind: 'issue',
      author: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      commentCount: 0
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    update: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    sync: vi.fn(),
    flushQueue: vi.fn()
  } as any
}

function createApp(dataDir: string, overrides?: { issueTracker?: any; getRemotes?: any }) {
  const app = express()
  app.use(express.json())
  const bus = createMockBus()
  const store = createDraftStore(dataDir)
  const issueTracker = overrides?.issueTracker ?? createMockIssueTracker()
  const getRemotes = overrides?.getRemotes ?? (() => [{ name: 'origin', provider: 'github' as const }])
  app.use(createDraftRouter(bus, store, { issueTracker, getRemotes }))
  return { app, bus, store, issueTracker }
}

describe('Draft REST API', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('§1.2 GET /api/drafts', () => {
    it('1.2 MUST support ?orgId=<id> — return drafts assigned to this workspace', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'A', orgId: 'org1' })
      store.create({ title: 'B', orgId: 'org2' })
      const res = await request(app).get('/api/drafts?orgId=org1')
      expect(res.status).toBe(200)
      expect(res.body.some((d: Draft) => d.orgId === 'org1')).toBe(true)
    })

    it('1.2 MUST support ?unassigned=true — return drafts with orgId null', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'A', orgId: null })
      store.create({ title: 'B', orgId: 'org1' })
      const res = await request(app).get('/api/drafts?unassigned=true')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(1)
      expect(res.body[0].orgId).toBeNull()
    })

    it('1.2 MUST support ?status=draft (default)', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'A' })
      const b = store.create({ title: 'B' })
      store.update(b.id, { status: 'published' })
      const res = await request(app).get('/api/drafts?status=draft')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(1)
      expect(res.body[0].status).toBe('draft')
    })

    it('1.2 MUST support ?status=published', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'A' })
      const b = store.create({ title: 'B' })
      store.update(b.id, { status: 'published' })
      const res = await request(app).get('/api/drafts?status=published')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(1)
      expect(res.body[0].status).toBe('published')
    })

    it('1.2 MUST support ?status=all', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'A' })
      const b = store.create({ title: 'B' })
      store.update(b.id, { status: 'published' })
      const res = await request(app).get('/api/drafts?status=all')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(2)
    })

    it('1.2 no filter MUST return all non-published drafts', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'A' })
      store.create({ title: 'B' })
      const c = store.create({ title: 'C' })
      store.update(c.id, { status: 'published' })
      const res = await request(app).get('/api/drafts')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(2)
    })

    it('1.2 ?orgId=<id> MUST also include unassigned drafts', async () => {
      const { app, store } = createApp(dataDir)
      store.create({ title: 'Assigned', orgId: 'org1' })
      store.create({ title: 'Unassigned', orgId: null })
      const res = await request(app).get('/api/drafts?orgId=org1')
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(2)
    })
  })

  describe('§1.2 POST /api/drafts', () => {
    it('1.2 MUST validate that title is non-empty', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).post('/api/drafts').send({ title: '' })
      expect(res.status).toBe(400)
    })

    it('1.2 MUST return 400 if title is empty', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).post('/api/drafts').send({})
      expect(res.status).toBe(400)
    })

    it('1.2 MUST create draft and return it on success', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).post('/api/drafts').send({ title: 'My Draft' })
      expect(res.status).toBe(201)
      expect(res.body.title).toBe('My Draft')
      expect(res.body.id).toBeTruthy()
    })
  })

  describe('§1.2 GET /api/drafts/:id', () => {
    it('1.2 MUST return the draft if found', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      const res = await request(app).get(`/api/drafts/${draft.id}`)
      expect(res.status).toBe(200)
      expect(res.body.id).toBe(draft.id)
    })

    it('1.2 MUST return 404 if not found', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).get('/api/drafts/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('§1.2 PATCH /api/drafts/:id', () => {
    it('1.2 MUST return 404 if draft not found', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).patch('/api/drafts/nonexistent').send({ title: 'X' })
      expect(res.status).toBe(404)
    })

    it('1.2 MUST update draft and return it on success', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Old' })
      const res = await request(app).patch(`/api/drafts/${draft.id}`).send({ title: 'New' })
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('New')
    })
  })

  describe('§1.2 DELETE /api/drafts/:id', () => {
    it('1.2 MUST return 204 on success', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      const res = await request(app).delete(`/api/drafts/${draft.id}`)
      expect(res.status).toBe(204)
    })

    it('1.2 MUST return 404 if not found', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).delete('/api/drafts/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('§1.2 POST /api/drafts/:id/dependencies', () => {
    it('1.2 MUST add dependency to draft', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      const dep = { type: 'depends_on', target: { kind: 'draft', draftId: 'other-id' } }
      const res = await request(app).post(`/api/drafts/${draft.id}/dependencies`).send(dep)
      expect(res.status).toBe(200)
      expect(res.body.dependencies.length).toBe(1)
    })
  })

  describe('§1.2 DELETE /api/drafts/:id/dependencies/:index', () => {
    it('1.2 MUST remove dependency by index', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({
        title: 'Test',
        dependencies: [
          { type: 'depends_on', target: { kind: 'draft', draftId: 'a' } },
          { type: 'depends_on', target: { kind: 'draft', draftId: 'b' } }
        ]
      })
      const res = await request(app).delete(`/api/drafts/${draft.id}/dependencies/0`)
      expect(res.status).toBe(200)
      expect(res.body.dependencies.length).toBe(1)
      expect(res.body.dependencies[0].target.draftId).toBe('b')
    })
  })

  describe('§4.1 POST /api/drafts/:id/publish', () => {
    it('4.1 MUST validate that draft exists and has status draft', async () => {
      const { app } = createApp(dataDir)
      const res = await request(app).post('/api/drafts/nonexistent/publish').send({ orgId: 'o', projectId: 'p' })
      expect(res.status).toBe(404)
    })

    it('4.1 MUST accept { orgId, projectId } in body', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      const res = await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      expect(res.status).toBe(200)
      expect(res.body.draft.status).toBe('published')
    })

    it('4.1 MUST determine correct provider for the project via getRemotes', async () => {
      const getRemotes = vi.fn().mockReturnValue([{ name: 'origin', provider: 'github' }])
      const { app, store } = createApp(dataDir, { getRemotes })
      const draft = store.create({ title: 'Test' })
      await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      expect(getRemotes).toHaveBeenCalledWith('org1', 'proj1')
    })

    it('4.1 MUST create issue on provider via issueTracker.create()', async () => {
      const issueTracker = createMockIssueTracker()
      const { app, store } = createApp(dataDir, { issueTracker })
      const draft = store.create({ title: 'My Issue' })
      await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      expect(issueTracker.create).toHaveBeenCalled()
      const callArgs = issueTracker.create.mock.calls[0]
      expect(callArgs[0]).toBe('org1')
      expect(callArgs[1]).toBe('proj1')
      expect(callArgs[2].title).toBe('My Issue')
    })

    it('4.1 MUST publish to the canonical remote when Radicle is ordered first', async () => {
      const issueTracker = createMockIssueTracker()
      const getRemotes = vi.fn().mockReturnValue([
        { name: 'rad', provider: 'radicle' },
        { name: 'origin', provider: 'github' }
      ])
      const { app, store } = createApp(dataDir, { issueTracker, getRemotes })
      const draft = store.create({ title: 'My Radicle Issue' })

      await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })

      expect(issueTracker.create).toHaveBeenCalledWith(
        'org1',
        'proj1',
        expect.objectContaining({ remote: 'rad', title: 'My Radicle Issue' })
      )
    })

    it('4.1 MUST set draft status to published and set publishedAs', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      const res = await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      expect(res.body.draft.status).toBe('published')
      expect(res.body.draft.publishedAs).toBeTruthy()
      expect(res.body.draft.publishedAs.orgId).toBe('org1')
      expect(res.body.draft.publishedAs.issueId).toBe('42')
    })

    it('4.1 MUST update other drafts that depended on this draft to point at new provider ref', async () => {
      const { app, store } = createApp(dataDir)
      const draftA = store.create({ title: 'A' })
      store.create({
        title: 'B',
        dependencies: [{ type: 'depends_on', target: { kind: 'draft', draftId: draftA.id } }]
      })
      await request(app).post(`/api/drafts/${draftA.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      // Refetch B
      const bList = store.list()
      const b = bList.find((d) => d.title === 'B')!
      expect(b.dependencies[0]!.target.kind).toBe('provider')
    })

    it('4.1 MUST return the created issue and updated draft', async () => {
      const { app, store } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      const res = await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      expect(res.body.draft).toBeTruthy()
      expect(res.body.issue).toBeTruthy()
      expect(res.body.issue.id).toBe('42')
    })

    it('4.1 MUST return 502 if provider create fails and MUST NOT change draft status', async () => {
      const issueTracker = createMockIssueTracker()
      issueTracker.create.mockRejectedValue(new Error('Provider error'))
      const { app, store } = createApp(dataDir, { issueTracker })
      const draft = store.create({ title: 'Test' })
      const res = await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      expect(res.status).toBe(502)
      // Draft status should NOT be changed
      const d = store.get(draft.id)!
      expect(d.status).toBe('draft')
    })

    it('4.1 MUST emit planning.draft.published on the event bus', async () => {
      const { app, store, bus } = createApp(dataDir)
      const draft = store.create({ title: 'Test' })
      await request(app).post(`/api/drafts/${draft.id}/publish`).send({ orgId: 'org1', projectId: 'proj1' })
      const publishCall = bus.emit.mock.calls.find((c: any) => c[0].type === 'planning.draft.published')
      expect(publishCall).toBeTruthy()
    })
  })
})
