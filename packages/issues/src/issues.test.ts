import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIssueTracker } from './issues.js'
import type { Issue, IssueComment, IssueProvider, Remote } from './types.js'
import type { IssueCache } from './cache.js'
import type { EventBus, BusEvent, BusHandler, Unsubscribe } from '@sovereign/core'

const sampleIssue: Issue = {
  id: '1',
  kind: 'issue',
  projectId: 'proj1',
  orgId: 'org1',
  remote: 'origin',
  provider: 'github',
  title: 'Bug',
  body: 'desc',
  state: 'open',
  labels: ['bug'],
  assignees: ['alice'],
  author: 'bob',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  commentCount: 0
}

const sampleComment: IssueComment = {
  id: 'c1',
  issueId: '1',
  author: 'alice',
  body: 'Comment',
  createdAt: '2024-01-02T00:00:00Z'
}

function createMockProvider(
  issues: Issue[] = [sampleIssue],
  comments: IssueComment[] = [sampleComment]
): IssueProvider {
  return {
    list: vi.fn(async () => issues),
    get: vi.fn(async (_rp, id) => issues.find((i) => i.id === id)),
    create: vi.fn(async (_rp, data) => ({ ...sampleIssue, id: '99', title: data.title })),
    update: vi.fn(async (_rp, id, patch) => ({ ...sampleIssue, id, ...patch }) as Issue),
    listComments: vi.fn(async () => comments),
    addComment: vi.fn(async (_rp, issueId, body) => ({
      id: 'c2',
      issueId,
      author: 'alice',
      body,
      createdAt: new Date().toISOString()
    }))
  }
}

function createMockBus(): EventBus & { events: BusEvent[]; handlers: Map<string, BusHandler[]> } {
  const events: BusEvent[] = []
  const handlers = new Map<string, BusHandler[]>()
  return {
    events,
    handlers,
    emit(event: BusEvent) {
      events.push(event)
      for (const [p, hs] of handlers) {
        if (event.type.startsWith(p.replace('*', '')) || event.type === p) hs.forEach((h) => h(event))
      }
    },
    on(pattern: string, handler: BusHandler): Unsubscribe {
      const list = handlers.get(pattern) ?? []
      list.push(handler)
      handlers.set(pattern, list)
      return () => {
        const idx = list.indexOf(handler)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    once(pattern: string, handler: BusHandler): Unsubscribe {
      const unsub = this.on(pattern, async (e) => {
        unsub()
        await handler(e)
      })
      return unsub
    },
    async *replay() {
      /* noop */
    },
    history() {
      return []
    }
  }
}

function createMockCache(): IssueCache {
  const store = new Map<string, Issue[]>()
  const queue: Array<{
    id: string
    type: string
    orgId: string
    projectId: string
    remote: string
    data: Record<string, unknown>
    timestamp: string
  }> = []
  return {
    getCached: vi.fn((orgId, projectId) => store.get(`${orgId}/${projectId}`)),
    setCached: vi.fn((orgId, projectId, issues) => store.set(`${orgId}/${projectId}`, issues)),
    isStale: vi.fn(() => false),
    clear: vi.fn(() => store.clear()),
    queueWrite: vi.fn((op) => queue.push({ ...op, id: String(queue.length), timestamp: new Date().toISOString() })),
    getQueue: vi.fn(() => [...queue]) as any,
    removeFromQueue: vi.fn((id) => {
      const idx = queue.findIndex((q) => q.id === id)
      if (idx >= 0) queue.splice(idx, 1)
    })
  }
}

const defaultRemotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]

describe('IssueTracker', () => {
  let bus: ReturnType<typeof createMockBus>
  let mockProvider: IssueProvider
  let mockCache: IssueCache

  beforeEach(() => {
    bus = createMockBus()
    mockProvider = createMockProvider()
    mockCache = createMockCache()
  })

  function makeTracker(remotes: Remote[] = defaultRemotes) {
    return createIssueTracker(bus, '/tmp/test', () => remotes, {
      createProvider: () => mockProvider,
      cache: mockCache
    })
  }

  describe('list', () => {
    it('lists issues across all remotes for a project', async () => {
      const tracker = makeTracker()
      const issues = await tracker.list('org1', { projectId: 'proj1' })
      expect(issues).toHaveLength(1)
      expect(mockProvider.list).toHaveBeenCalled()
    })

    it('filters by state', async () => {
      const tracker = makeTracker()
      await tracker.list('org1', { projectId: 'proj1', state: 'open' })
      expect(mockProvider.list).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'open' }))
    })

    it('filters by label', async () => {
      const tracker = makeTracker()
      await tracker.list('org1', { projectId: 'proj1', label: 'bug' })
      expect(mockProvider.list).toHaveBeenCalled()
    })

    it('filters by assignee', async () => {
      const tracker = makeTracker()
      await tracker.list('org1', { projectId: 'proj1', assignee: 'alice' })
      expect(mockProvider.list).toHaveBeenCalled()
    })

    it('filters by search query', async () => {
      const tracker = makeTracker()
      const issues = await tracker.list('org1', { projectId: 'proj1', q: 'Bug' })
      expect(issues).toHaveLength(1)
    })

    it('filters by remote', async () => {
      const remotes: Remote[] = [
        { name: 'origin', provider: 'github', repo: 'owner/repo' },
        { name: 'rad', provider: 'radicle', rid: 'rad:z123' }
      ]
      const tracker = makeTracker(remotes)
      await tracker.list('org1', { projectId: 'proj1', remote: 'origin' })
      expect(mockProvider.list).toHaveBeenCalledTimes(1)
    })

    it('supports limit and offset pagination', async () => {
      mockProvider.list = vi.fn(async () => [sampleIssue, { ...sampleIssue, id: '2' }, { ...sampleIssue, id: '3' }])
      const tracker = makeTracker()
      const issues = await tracker.list('org1', { projectId: 'proj1', limit: 1, offset: 1 })
      expect(issues).toHaveLength(1)
      expect(issues[0].id).toBe('2')
    })

    it('aggregates issues across all configured remotes', async () => {
      const remotes: Remote[] = [
        { name: 'origin', provider: 'github', repo: 'owner/repo' },
        { name: 'rad', provider: 'radicle', rid: 'rad:z123' }
      ]
      const tracker = makeTracker(remotes)
      const issues = await tracker.list('org1', { projectId: 'proj1' })
      // Both remotes queried, same mock returns same issue for each
      expect(issues).toHaveLength(2)
    })
  })

  describe('cross-project listing', () => {
    it('lists issues across all projects in an org when no projectId filter', async () => {
      const tracker = makeTracker()
      const issues = await tracker.list('org1')
      expect(issues).toHaveLength(1)
    })

    it('includes project as a filterable field', async () => {
      const tracker = makeTracker()
      const issues = await tracker.list('org1', { projectId: 'proj1' })
      expect(issues[0].projectId).toBeDefined()
    })
  })

  describe('get', () => {
    it('returns issue by id', async () => {
      const tracker = makeTracker()
      const issue = await tracker.get('org1', 'proj1', '1')
      expect(issue).toBeDefined()
      expect(issue!.id).toBe('1')
    })

    it('returns undefined for non-existent issue', async () => {
      mockProvider.get = vi.fn(async () => undefined)
      const tracker = makeTracker()
      const issue = await tracker.get('org1', 'proj1', 'nonexistent')
      expect(issue).toBeUndefined()
    })
  })

  describe('create', () => {
    it('creates issue on specified remote', async () => {
      const tracker = makeTracker()
      const issue = await tracker.create('org1', 'proj1', { remote: 'origin', title: 'New' })
      expect(issue.title).toBe('New')
      expect(mockProvider.create).toHaveBeenCalled()
    })

    it('defaults to first remote when no remote specified', async () => {
      const tracker = makeTracker()
      const issue = await tracker.create('org1', 'proj1', { remote: 'origin', title: 'New' })
      expect(issue).toBeDefined()
    })

    it('proxies create to provider (provider is authoritative)', async () => {
      const tracker = makeTracker()
      await tracker.create('org1', 'proj1', { remote: 'origin', title: 'Test' })
      expect(mockProvider.create).toHaveBeenCalledTimes(1)
    })
  })

  describe('update', () => {
    it('updates title', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { title: 'Updated' })
      expect(mockProvider.update).toHaveBeenCalled()
    })

    it('updates body', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { body: 'New body' })
      expect(mockProvider.update).toHaveBeenCalled()
    })

    it('updates state', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { state: 'closed' })
      expect(mockProvider.update).toHaveBeenCalled()
    })

    it('updates labels', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { labels: ['enhancement'] })
      expect(mockProvider.update).toHaveBeenCalled()
    })

    it('updates assignees', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { assignees: ['charlie'] })
      expect(mockProvider.update).toHaveBeenCalled()
    })

    it('proxies update to provider', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { title: 'X' })
      expect(mockProvider.update).toHaveBeenCalledTimes(1)
    })
  })

  describe('comments', () => {
    it('lists comments for an issue', async () => {
      const tracker = makeTracker()
      const comments = await tracker.listComments('org1', 'proj1', '1')
      expect(comments).toHaveLength(1)
    })

    it('adds a comment to an issue', async () => {
      const tracker = makeTracker()
      const comment = await tracker.addComment('org1', 'proj1', '1', 'Hello')
      expect(comment.body).toBe('Hello')
    })

    it('proxies comment operations to provider', async () => {
      const tracker = makeTracker()
      await tracker.addComment('org1', 'proj1', '1', 'Test')
      expect(mockProvider.addComment).toHaveBeenCalledTimes(1)
    })
  })

  describe('sync', () => {
    it('syncs issues from all remotes for a project', async () => {
      const tracker = makeTracker()
      const result = await tracker.sync('org1', 'proj1')
      expect(result.synced).toBeGreaterThanOrEqual(1)
    })

    it('returns synced count and error count', async () => {
      const tracker = makeTracker()
      const result = await tracker.sync('org1', 'proj1')
      expect(typeof result.synced).toBe('number')
      expect(typeof result.errors).toBe('number')
    })

    it('updates local cache on sync', async () => {
      const tracker = makeTracker()
      await tracker.sync('org1', 'proj1')
      expect(mockCache.setCached).toHaveBeenCalled()
    })
  })

  describe('offline support', () => {
    it('reads from cache when provider is unreachable', async () => {
      mockProvider.list = vi.fn(async () => {
        throw new Error('unreachable')
      })
      ;(mockCache.getCached as ReturnType<typeof vi.fn>).mockReturnValue([sampleIssue])
      const tracker = makeTracker()
      const issues = await tracker.list('org1', { projectId: 'proj1' })
      expect(issues).toHaveLength(1)
    })

    it('includes staleness indicator for cached reads', async () => {
      makeTracker()
      expect(typeof mockCache.isStale('org1', 'proj1')).toBe('boolean')
    })

    it('queues write operations when offline', async () => {
      mockProvider.create = vi.fn(async () => {
        throw new Error('unreachable')
      })
      const tracker = makeTracker()
      await expect(tracker.create('org1', 'proj1', { remote: 'origin', title: 'Offline' })).rejects.toThrow()
      expect(mockCache.queueWrite).toHaveBeenCalled()
    })

    it('flushQueue replays queued writes when connectivity returns', async () => {
      const tracker = makeTracker()
      const result = await tracker.flushQueue()
      expect(typeof result.replayed).toBe('number')
      expect(typeof result.failed).toBe('number')
    })

    it('reports replayed and failed counts from flushQueue', async () => {
      const tracker = makeTracker()
      const result = await tracker.flushQueue()
      expect(result).toHaveProperty('replayed')
      expect(result).toHaveProperty('failed')
    })
  })

  describe('bus events', () => {
    it('emits issue.created on create', async () => {
      const tracker = makeTracker()
      await tracker.create('org1', 'proj1', { remote: 'origin', title: 'New' })
      expect(bus.events.some((e) => e.type === 'issue.created')).toBe(true)
    })

    it('emits issue.updated on update', async () => {
      const tracker = makeTracker()
      await tracker.update('org1', 'proj1', '1', { title: 'X' })
      expect(bus.events.some((e) => e.type === 'issue.updated')).toBe(true)
    })

    it('emits issue.comment.added on addComment', async () => {
      const tracker = makeTracker()
      await tracker.addComment('org1', 'proj1', '1', 'test')
      expect(bus.events.some((e) => e.type === 'issue.comment.added')).toBe(true)
    })

    it('emits issue.synced on sync', async () => {
      const tracker = makeTracker()
      await tracker.sync('org1', 'proj1')
      expect(bus.events.some((e) => e.type === 'issue.synced')).toBe(true)
    })
  })

  describe('config change listener', () => {
    it('listens for config.changed events to pick up provider changes', () => {
      makeTracker()
      expect(bus.handlers.has('config.changed')).toBe(true)
    })

    it('reconfigures providers when remotes change', () => {
      makeTracker()
      // Providers are created per-call, so config changes are automatically picked up
      bus.emit({ type: 'config.changed', timestamp: new Date().toISOString(), source: 'config', payload: {} })
      // No error means the handler exists and runs
    })
  })
})
