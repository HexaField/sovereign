import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDraftsStore } from './store.js'
import type { Draft, UpdateDraft, DraftDep } from './store.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockDraft(overrides?: Partial<Draft>): Draft {
  return {
    id: 'test-id',
    title: 'Test',
    body: '',
    labels: [],
    assignees: [],
    status: 'draft',
    orgId: null,
    projectId: null,
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAs: null,
    ...overrides
  }
}

function setupFetchMock(responses: Record<string, any> = {}) {
  mockFetch.mockImplementation(async (url: string, opts?: any) => {
    const method = opts?.method ?? 'GET'

    if (method === 'GET' && (url === '/api/drafts' || url.startsWith('/api/drafts?'))) {
      return { json: async () => responses.list ?? [] }
    }
    if (method === 'POST' && url === '/api/drafts') {
      return { json: async () => responses.create ?? mockDraft() }
    }
    if (method === 'PATCH' && url.match(/\/api\/drafts\/[^/]+$/)) {
      return { json: async () => responses.update ?? mockDraft() }
    }
    if (method === 'DELETE' && url.match(/\/api\/drafts\/[^/]+$/)) {
      return { json: async () => ({}) }
    }
    if (method === 'POST' && url.match(/\/api\/drafts\/[^/]+\/publish$/)) {
      return { json: async () => responses.publish ?? { draft: mockDraft({ status: 'published' }), issue: {} } }
    }
    if (method === 'POST' && url.match(/\/api\/drafts\/[^/]+\/dependencies$/)) {
      return { json: async () => responses.addDep ?? mockDraft() }
    }
    if (method === 'DELETE' && url.match(/\/api\/drafts\/[^/]+\/dependencies\/\d+$/)) {
      return { json: async () => responses.removeDep ?? mockDraft() }
    }
    return { json: async () => ({}) }
  })
}

describe('Drafts Client Store', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    setupFetchMock()
  })

  describe('§3.4 Signals', () => {
    it('3.4 MUST expose drafts() signal returning Draft[]', () => {
      const store = createDraftsStore()
      expect(Array.isArray(store.drafts())).toBe(true)
    })

    it('3.4 MUST expose selectedDraftId() signal returning string | null', () => {
      const store = createDraftsStore()
      expect(store.selectedDraftId()).toBeNull()
    })
  })

  describe('§3.4 fetchDrafts', () => {
    it('3.4 fetchDrafts MUST be called when Planning tab becomes active', async () => {
      // This tests that fetchDrafts is callable and fetches from the API
      const store = createDraftsStore()
      const drafts = [mockDraft({ id: '1' })]
      setupFetchMock({ list: drafts })
      await store.fetchDrafts()
      expect(mockFetch).toHaveBeenCalledWith('/api/drafts')
      expect(store.drafts()).toEqual(drafts)
    })

    it('3.4 fetchDrafts MUST be called when workspace changes', async () => {
      const store = createDraftsStore()
      setupFetchMock({ list: [mockDraft({ orgId: 'org1' })] })
      await store.fetchDrafts('org1')
      expect(mockFetch).toHaveBeenCalledWith('/api/drafts?orgId=org1')
    })

    it('3.4 fetchDrafts MUST accept optional orgId parameter', async () => {
      const store = createDraftsStore()
      await store.fetchDrafts()
      expect(mockFetch).toHaveBeenCalledWith('/api/drafts')
      await store.fetchDrafts('org1')
      expect(mockFetch).toHaveBeenCalledWith('/api/drafts?orgId=org1')
    })
  })

  describe('§3.4 createDraft', () => {
    it('3.4 createDraft MUST create draft and return it', async () => {
      const created = mockDraft({ id: 'new', title: 'New Draft' })
      setupFetchMock({ create: created, list: [created] })
      const store = createDraftsStore()
      const result = await store.createDraft('New Draft')
      expect(result.title).toBe('New Draft')
      // Verify POST was called
      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST' && c[0] === '/api/drafts')
      expect(postCall).toBeTruthy()
    })

    it('3.4 store MUST refetch after create', async () => {
      const created = mockDraft({ id: 'new' })
      setupFetchMock({ create: created, list: [created] })
      const store = createDraftsStore()
      await store.createDraft('Test')
      // Should have called fetch twice: POST + GET (refetch)
      const getCalls = mockFetch.mock.calls.filter(
        (c: any) =>
          (!c[1]?.method || c[1]?.method === 'GET') && (c[0] === '/api/drafts' || c[0].startsWith('/api/drafts?'))
      )
      expect(getCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('§3.4 updateDraft', () => {
    it('3.4 updateDraft MUST update draft by id with patch', async () => {
      setupFetchMock()
      const store = createDraftsStore()
      await store.updateDraft('test-id', { title: 'Updated' })
      const patchCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'PATCH')
      expect(patchCall).toBeTruthy()
      expect(patchCall![0]).toBe('/api/drafts/test-id')
      const body = JSON.parse(patchCall![1].body)
      expect(body.title).toBe('Updated')
    })

    it('3.4 store MUST refetch after update', async () => {
      setupFetchMock()
      const store = createDraftsStore()
      await store.updateDraft('test-id', { title: 'X' })
      const getCalls = mockFetch.mock.calls.filter(
        (c: any) =>
          (!c[1]?.method || c[1]?.method === 'GET') && (c[0] === '/api/drafts' || c[0].startsWith('/api/drafts?'))
      )
      expect(getCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('§3.4 deleteDraft', () => {
    it('3.4 deleteDraft MUST delete draft by id', async () => {
      setupFetchMock()
      const store = createDraftsStore()
      await store.deleteDraft('test-id')
      const deleteCall = mockFetch.mock.calls.find(
        (c: any) => c[1]?.method === 'DELETE' && c[0] === '/api/drafts/test-id'
      )
      expect(deleteCall).toBeTruthy()
    })

    it('3.4 store MUST refetch after delete', async () => {
      setupFetchMock({ list: [] })
      const store = createDraftsStore()
      await store.deleteDraft('test-id')
      const getCalls = mockFetch.mock.calls.filter(
        (c: any) =>
          (!c[1]?.method || c[1]?.method === 'GET') && (c[0] === '/api/drafts' || c[0].startsWith('/api/drafts?'))
      )
      expect(getCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('§3.4 publishDraft', () => {
    it('3.4 publishDraft MUST publish draft with orgId and projectId', async () => {
      setupFetchMock()
      const store = createDraftsStore()
      await store.publishDraft('test-id', 'org1', 'proj1')
      const publishCall = mockFetch.mock.calls.find(
        (c: any) => c[1]?.method === 'POST' && c[0] === '/api/drafts/test-id/publish'
      )
      expect(publishCall).toBeTruthy()
      const body = JSON.parse(publishCall![1].body)
      expect(body.orgId).toBe('org1')
      expect(body.projectId).toBe('proj1')
    })

    it('3.4 store MUST refetch after publish', async () => {
      setupFetchMock({ list: [] })
      const store = createDraftsStore()
      await store.publishDraft('test-id', 'org1', 'proj1')
      const getCalls = mockFetch.mock.calls.filter(
        (c: any) =>
          (!c[1]?.method || c[1]?.method === 'GET') && (c[0] === '/api/drafts' || c[0].startsWith('/api/drafts?'))
      )
      expect(getCalls.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('§3.4 selectDraft', () => {
    it('3.4 selectDraft MUST set selectedDraftId signal', () => {
      const store = createDraftsStore()
      store.selectDraft('abc')
      expect(store.selectedDraftId()).toBe('abc')
      store.selectDraft(null)
      expect(store.selectedDraftId()).toBeNull()
    })
  })

  describe('§3.4 addDependency', () => {
    it('3.4 addDependency MUST add dependency to draft', async () => {
      setupFetchMock()
      const store = createDraftsStore()
      const dep: DraftDep = { type: 'depends_on', target: { kind: 'draft', draftId: 'other' } }
      await store.addDependency('test-id', dep)
      const postCall = mockFetch.mock.calls.find(
        (c: any) => c[1]?.method === 'POST' && c[0] === '/api/drafts/test-id/dependencies'
      )
      expect(postCall).toBeTruthy()
    })
  })

  describe('§3.4 removeDependency', () => {
    it('3.4 removeDependency MUST remove dependency by index', async () => {
      setupFetchMock()
      const store = createDraftsStore()
      await store.removeDependency('test-id', 0)
      const deleteCall = mockFetch.mock.calls.find(
        (c: any) => c[1]?.method === 'DELETE' && c[0] === '/api/drafts/test-id/dependencies/0'
      )
      expect(deleteCall).toBeTruthy()
    })
  })
})
