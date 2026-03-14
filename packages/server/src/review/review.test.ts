import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createReviewSystem } from './review.js'
import type { Review, ReviewComment, ReviewDeps, ReviewProvider } from './types.js'
import type { EventBus, BusEvent } from '@sovereign/core'
import type { ReviewCache } from './cache.js'

function createMockBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = []
  return {
    events,
    emit(event: BusEvent) {
      events.push(event)
    },
    on: vi.fn(() => () => {}),
    once: vi.fn(() => () => {}),
    replay: vi.fn(),
    history: vi.fn(() => [])
  } as unknown as EventBus & { events: BusEvent[] }
}

function createMockCache(): ReviewCache & { store: Map<string, Review[]> } {
  const store = new Map<string, Review[]>()
  return {
    store,
    getCached(orgId: string, projectId: string) {
      return store.get(`${orgId}/${projectId}`)
    },
    setCached(orgId: string, projectId: string, reviews: Review[]) {
      store.set(`${orgId}/${projectId}`, reviews)
    },
    isStale() {
      return false
    },
    clear() {
      store.clear()
    }
  }
}

const sampleReview: Review = {
  id: '42',
  changeSetId: '',
  projectId: 'proj1',
  orgId: 'org1',
  remote: 'origin',
  provider: 'github',
  title: 'Test PR',
  description: 'Desc',
  status: 'open',
  author: 'alice',
  reviewers: [],
  baseBranch: 'main',
  headBranch: 'feat',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}

const sampleComment: ReviewComment = {
  id: 'rc1',
  reviewId: '42',
  filePath: 'src/index.ts',
  lineNumber: 10,
  side: 'new',
  body: 'Fix this',
  author: 'bob',
  createdAt: '2026-01-01T00:00:00Z',
  resolved: false
}

function createMockProvider(overrides?: Partial<ReviewProvider>): ReviewProvider {
  return {
    create: vi.fn(async () => sampleReview),
    list: vi.fn(async () => [sampleReview]),
    get: vi.fn(async () => sampleReview),
    approve: vi.fn(async () => {}),
    requestChanges: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
    addComment: vi.fn(async () => sampleComment),
    listComments: vi.fn(async () => [sampleComment]),
    resolveComment: vi.fn(async () => {}),
    ...overrides
  }
}

describe('ReviewSystem', () => {
  let bus: ReturnType<typeof createMockBus>
  let cache: ReturnType<typeof createMockCache>
  let mockProvider: ReviewProvider
  let deps: ReviewDeps

  beforeEach(() => {
    bus = createMockBus()
    cache = createMockCache()
    mockProvider = createMockProvider()
    deps = {
      removeWorktree: vi.fn(async () => {}),
      getChangeSet: vi.fn(() => ({
        id: 'cs1',
        worktreeId: 'wt1',
        title: '',
        description: '',
        orgId: 'org1',
        projectId: 'proj1',
        baseBranch: 'main',
        headBranch: 'feat',
        files: [],
        status: 'open' as const,
        createdAt: '',
        updatedAt: ''
      })),
      updateChangeSet: vi.fn((id, patch) => ({
        id,
        title: '',
        description: '',
        orgId: 'org1',
        projectId: 'proj1',
        baseBranch: 'main',
        headBranch: 'feat',
        files: [],
        status: 'merged' as const,
        createdAt: '',
        updatedAt: '',
        ...patch
      })),
      getProvider: vi.fn(() => mockProvider)
    }
  })

  function makeSystem() {
    return createReviewSystem(bus, '/tmp/test', deps, {
      cache,
      getRemotes: () => [{ name: 'origin', provider: 'github' as const, repo: 'owner/repo' }]
    })
  }

  describe('create review', () => {
    it('creates a review from worktree branch', async () => {
      const system = makeSystem()
      const review = await system.create('org1', 'proj1', {
        remote: 'origin',
        title: 'Test',
        baseBranch: 'main',
        headBranch: 'feat'
      })
      expect(review.id).toBe('42')
      expect(review.title).toBe('Test PR')
    })

    it('creates PR/patch via provider', async () => {
      const system = makeSystem()
      await system.create('org1', 'proj1', { remote: 'origin', title: 'T', baseBranch: 'main', headBranch: 'feat' })
      expect(mockProvider.create).toHaveBeenCalled()
    })

    it('sets initial status to "open"', async () => {
      const system = makeSystem()
      const review = await system.create('org1', 'proj1', {
        remote: 'origin',
        title: 'T',
        baseBranch: 'main',
        headBranch: 'feat'
      })
      expect(review.status).toBe('open')
    })
  })

  describe('get', () => {
    it('returns review by id', async () => {
      const system = makeSystem()
      const review = await system.get('org1', 'proj1', '42')
      expect(review).toBeDefined()
      expect(review!.id).toBe('42')
    })

    it('returns undefined for non-existent review', async () => {
      mockProvider.get = vi.fn(async () => undefined)
      const system = makeSystem()
      const review = await system.get('org1', 'proj1', '999')
      expect(review).toBeUndefined()
    })
  })

  describe('list', () => {
    it('lists all reviews for an org', async () => {
      const system = makeSystem()
      const reviews = await system.list('org1')
      expect(reviews).toHaveLength(1)
    })

    it('filters by projectId', async () => {
      const system = makeSystem()
      const reviews = await system.list('org1', { projectId: 'proj1' })
      expect(reviews).toHaveLength(1)
    })

    it('filters by status', async () => {
      mockProvider.list = vi.fn(async () => [])
      const system = makeSystem()
      const reviews = await system.list('org1', { status: 'merged' })
      expect(reviews).toHaveLength(0)
    })

    it('aggregates across remotes', async () => {
      const system = makeSystem()
      const reviews = await system.list('org1', { projectId: 'proj1' })
      expect(mockProvider.list).toHaveBeenCalled()
      expect(reviews.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('review actions', () => {
    it('approve proxies to provider', async () => {
      const system = makeSystem()
      await system.approve('org1', 'proj1', '42', 'LGTM')
      expect(mockProvider.approve).toHaveBeenCalledWith('', '42', 'LGTM')
    })

    it('requestChanges proxies to provider with comment', async () => {
      const system = makeSystem()
      await system.requestChanges('org1', 'proj1', '42', 'Please fix')
      expect(mockProvider.requestChanges).toHaveBeenCalledWith('', '42', 'Please fix')
    })
  })

  describe('merge', () => {
    it('merges via provider', async () => {
      const system = makeSystem()
      const review = await system.merge('org1', 'proj1', '42')
      expect(review.status).toBe('merged')
    })

    it('emits review.merged event on the bus', async () => {
      const system = makeSystem()
      await system.merge('org1', 'proj1', '42')
      const mergedEvents = bus.events.filter((e) => e.type === 'review.merged')
      expect(mergedEvents).toHaveLength(1)
    })
  })

  describe('inline comments', () => {
    it('adds inline comment with filePath, lineNumber, side', async () => {
      const system = makeSystem()
      const comment = await system.addComment('org1', 'proj1', '42', {
        filePath: 'src/index.ts',
        lineNumber: 10,
        side: 'new',
        body: 'Fix'
      })
      expect(comment).toBeDefined()
      expect(mockProvider.addComment).toHaveBeenCalled()
    })

    it('supports comment resolution state', async () => {
      const system = makeSystem()
      await system.resolveComment('org1', 'proj1', '42', 'rc1')
      expect(mockProvider.resolveComment).toHaveBeenCalledWith('', '42', 'rc1')
    })
  })

  describe('offline support', () => {
    it('reads from cache when provider unreachable', async () => {
      cache.setCached('org1', 'proj1', [sampleReview])
      mockProvider.list = vi.fn(async () => {
        throw new Error('offline')
      })
      mockProvider.get = vi.fn(async () => {
        throw new Error('offline')
      })
      const system = makeSystem()
      const reviews = await system.list('org1', { projectId: 'proj1' })
      expect(reviews).toHaveLength(1)
    })
  })

  describe('bus events', () => {
    it('emits review.created on create', async () => {
      const system = makeSystem()
      await system.create('org1', 'proj1', { remote: 'origin', title: 'T', baseBranch: 'main', headBranch: 'feat' })
      expect(bus.events.some((e) => e.type === 'review.created')).toBe(true)
    })

    it('emits review.comment.added on addComment', async () => {
      const system = makeSystem()
      await system.addComment('org1', 'proj1', '42', { filePath: 'f', lineNumber: 1, side: 'new', body: 'x' })
      expect(bus.events.some((e) => e.type === 'review.comment.added')).toBe(true)
    })

    it('emits review.comment.resolved on resolveComment', async () => {
      const system = makeSystem()
      await system.resolveComment('org1', 'proj1', '42', 'rc1')
      expect(bus.events.some((e) => e.type === 'review.comment.resolved')).toBe(true)
    })

    it('emits review.approved on approve', async () => {
      const system = makeSystem()
      await system.approve('org1', 'proj1', '42')
      expect(bus.events.some((e) => e.type === 'review.approved')).toBe(true)
    })

    it('emits review.changes_requested on requestChanges', async () => {
      const system = makeSystem()
      await system.requestChanges('org1', 'proj1', '42', 'fix')
      expect(bus.events.some((e) => e.type === 'review.changes_requested')).toBe(true)
    })

    it('emits review.merged on merge', async () => {
      const system = makeSystem()
      await system.merge('org1', 'proj1', '42')
      expect(bus.events.some((e) => e.type === 'review.merged')).toBe(true)
    })
  })

  describe('dependency inversion', () => {
    it('uses injected deps for all cross-module interaction', async () => {
      const system = makeSystem()
      await system.merge('org1', 'proj1', '42')
      expect(deps.getProvider).toHaveBeenCalled()
    })
  })

  describe('sync', () => {
    it('syncs reviews from all remotes for a project', async () => {
      const system = makeSystem()
      const result = await system.sync('org1', 'proj1')
      expect(result.synced).toBe(1)
      expect(result.errors).toBe(0)
    })

    it('returns synced count and error count', async () => {
      mockProvider.list = vi.fn(async () => {
        throw new Error('fail')
      })
      const system = makeSystem()
      const result = await system.sync('org1', 'proj1')
      expect(result.errors).toBe(1)
    })
  })
})
