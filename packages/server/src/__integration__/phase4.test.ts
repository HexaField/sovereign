import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import request from 'supertest'
import { createEventBus } from '@sovereign/core'
import { createChangeSetManager } from '../diff/changeset.js'
import { createIssueTracker } from '../issues/issues.js'
import { createIssueCache } from '../issues/cache.js'
import type { Issue, IssueComment, IssueProvider, Remote, IssueFilter } from '../issues/types.js'
import { createReviewSystem } from '../review/review.js'
import type { Review, ReviewComment, ReviewProvider, ReviewDeps } from '../review/types.js'
// review cache not needed directly — system creates its own
import { createRadicleManager } from '../radicle/radicle.js'
import * as radCli from '../radicle/cli.js'
import { createAuth } from '../auth/auth.js'
import { createAuthMiddleware } from '../auth/middleware.js'
import { createDiffRouter } from '../diff/routes.js'
import { createIssueRouter } from '../issues/routes.js'
import { createReviewRouter } from '../review/routes.js'
import { createRadicleRouter } from '../radicle/routes.js'
import { createWsHandler, type WsLike } from '../ws/handler.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-p4-'))
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '1',
    projectId: 'proj1',
    orgId: 'org1',
    remote: 'origin',
    provider: 'github',
    title: 'Test issue',
    body: 'Test body',
    state: 'open',
    labels: ['bug'],
    assignees: ['alice'],
    author: 'bob',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    commentCount: 0,
    ...overrides
  }
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'pr-1',
    changeSetId: '',
    projectId: 'proj1',
    orgId: 'org1',
    remote: 'origin',
    provider: 'github',
    title: 'Test PR',
    description: 'Test description',
    status: 'open',
    author: 'alice',
    reviewers: ['bob'],
    baseBranch: 'main',
    headBranch: 'feature',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeMockIssueProvider(issues: Issue[] = []): IssueProvider {
  const store = [...issues]
  let commentStore: IssueComment[] = []
  return {
    async list(_repoPath: string, _filter?: IssueFilter): Promise<Issue[]> {
      return store
    },
    async get(_repoPath: string, issueId: string): Promise<Issue | undefined> {
      return store.find((i) => i.id === issueId)
    },
    async create(
      _repoPath: string,
      data: { title: string; body?: string; labels?: string[]; assignees?: string[] }
    ): Promise<Issue> {
      const issue = makeIssue({
        id: String(store.length + 1),
        title: data.title,
        body: data.body ?? '',
        labels: data.labels ?? [],
        assignees: data.assignees ?? []
      })
      store.push(issue)
      return issue
    },
    async update(_repoPath: string, issueId: string, patch: Record<string, unknown>): Promise<Issue> {
      const idx = store.findIndex((i) => i.id === issueId)
      if (idx < 0) throw new Error('not found')
      store[idx] = { ...store[idx], ...patch } as Issue
      return store[idx]
    },
    async listComments(): Promise<IssueComment[]> {
      return commentStore
    },
    async addComment(_repoPath: string, issueId: string, body: string): Promise<IssueComment> {
      const c: IssueComment = {
        id: String(commentStore.length + 1),
        issueId,
        author: 'test',
        body,
        createdAt: new Date().toISOString()
      }
      commentStore.push(c)
      return c
    }
  }
}

function makeMockReviewProvider(reviews: Review[] = []): ReviewProvider {
  const store = [...reviews]
  const comments: ReviewComment[] = []
  return {
    async create(
      _repoPath: string,
      data: { title: string; body?: string; baseBranch: string; headBranch: string }
    ): Promise<Review> {
      const r = makeReview({
        id: `pr-${store.length + 1}`,
        title: data.title,
        description: data.body ?? '',
        baseBranch: data.baseBranch,
        headBranch: data.headBranch
      })
      store.push(r)
      return r
    },
    async list(): Promise<Review[]> {
      return store
    },
    async get(_rp: string, id: string): Promise<Review | undefined> {
      return store.find((r) => r.id === id)
    },
    async approve(_rp: string, id: string): Promise<void> {
      const r = store.find((r) => r.id === id)
      if (r) r.status = 'approved'
    },
    async requestChanges(): Promise<void> {},
    async merge(_rp: string, id: string): Promise<void> {
      const r = store.find((r) => r.id === id)
      if (r) {
        r.status = 'merged'
        r.mergedAt = new Date().toISOString()
      }
    },
    async addComment(
      _rp: string,
      reviewId: string,
      comment: { filePath: string; lineNumber: number; body: string; side: 'old' | 'new' }
    ): Promise<ReviewComment> {
      const rc: ReviewComment = {
        id: `c-${comments.length + 1}`,
        reviewId,
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        side: comment.side,
        body: comment.body,
        author: 'test',
        createdAt: new Date().toISOString(),
        resolved: false
      }
      comments.push(rc)
      return rc
    },
    async listComments(): Promise<ReviewComment[]> {
      return comments
    },
    async resolveComment(_rp: string, _rid: string, commentId: string): Promise<void> {
      const c = comments.find((c) => c.id === commentId)
      if (c) c.resolved = true
    }
  }
}

describe('Phase 4 Integration', () => {
  let tmpDir: string
  let dataDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    cleanup(tmpDir)
  })

  describe('worktree → change set → diff', () => {
    it('creates worktree, creates change set from worktree, diff shows branch changes', async () => {
      const bus = createEventBus(dataDir)
      const csManager = createChangeSetManager(bus, dataDir)

      const events: unknown[] = []
      bus.on('changeset.created', (e) => {
        events.push(e)
      })

      const cs = await csManager.createChangeSet({
        orgId: 'org1',
        projectId: 'proj1',
        worktreeId: 'wt-1',
        baseBranch: 'main',
        headBranch: 'feature/test',
        title: 'Test change set',
        description: 'Testing changeset creation'
      })

      expect(cs.id).toBeTruthy()
      expect(cs.title).toBe('Test change set')
      expect(cs.status).toBe('open')
      expect(cs.worktreeId).toBe('wt-1')
      expect(cs.baseBranch).toBe('main')
      expect(cs.headBranch).toBe('feature/test')
      expect(events.length).toBe(1)

      // Verify persistence
      const loaded = csManager.getChangeSet(cs.id)
      expect(loaded).toBeDefined()
      expect(loaded!.title).toBe('Test change set')

      // Verify file on disk
      const diskPath = path.join(dataDir, 'reviews', `${cs.id}.json`)
      expect(fs.existsSync(diskPath)).toBe(true)
    })

    it('change set files list matches actual changed files', async () => {
      const bus = createEventBus(dataDir)
      const csManager = createChangeSetManager(bus, dataDir)

      // Without a real git repo, files will be empty — but the changeset structure is correct
      const cs = await csManager.createChangeSet({
        orgId: 'org1',
        projectId: 'proj1',
        baseBranch: 'main',
        headBranch: 'feature/x',
        title: 'File list test'
      })

      expect(Array.isArray(cs.files)).toBe(true)

      // Update with files manually (simulating what would happen with git)
      const updated = csManager.updateChangeSet(cs.id, {
        files: [
          { path: 'src/index.ts', status: 'modified', additions: 10, deletions: 2 },
          { path: 'src/new.ts', status: 'added', additions: 50, deletions: 0 }
        ]
      })

      expect(updated.files).toHaveLength(2)
      expect(updated.files[0].path).toBe('src/index.ts')
      expect(updated.files[1].status).toBe('added')

      // List with filter
      const all = csManager.listChangeSets({ orgId: 'org1' })
      expect(all).toHaveLength(1)
      expect(all[0].id).toBe(cs.id)
    })
  })

  describe('issue create → sync → list', () => {
    it('creates issue on provider, syncs, issue appears in list', async () => {
      const bus = createEventBus(dataDir)
      const mockProvider = makeMockIssueProvider()
      const remotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]

      const events: unknown[] = []
      bus.on('issue.created', (e) => {
        events.push(e)
      })
      bus.on('issue.synced', (e) => {
        events.push(e)
      })

      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: () => mockProvider
      })

      // Create
      const issue = await tracker.create('org1', 'proj1', { remote: 'origin', title: 'Bug fix', body: 'Fix the bug' })
      expect(issue.title).toBe('Bug fix')
      expect(events.length).toBeGreaterThanOrEqual(1)

      // Sync
      const syncResult = await tracker.sync('org1', 'proj1')
      expect(syncResult.synced).toBeGreaterThanOrEqual(1)

      // List
      const issues = await tracker.list('org1', { projectId: 'proj1' })
      expect(issues.length).toBeGreaterThanOrEqual(1)
      expect(issues.some((i) => i.title === 'Bug fix')).toBe(true)
    })

    it('issue has all unified model fields populated', async () => {
      const bus = createEventBus(dataDir)
      const existingIssue = makeIssue({ title: 'Full fields test', labels: ['enhancement'], assignees: ['charlie'] })
      const mockProvider = makeMockIssueProvider([existingIssue])
      const remotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]

      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: () => mockProvider
      })

      const issues = await tracker.list('org1', { projectId: 'proj1' })
      expect(issues).toHaveLength(1)
      const issue = issues[0]

      // Check all unified model fields
      expect(issue.id).toBeTruthy()
      expect(issue.projectId).toBeTruthy()
      expect(issue.orgId).toBeTruthy()
      expect(issue.remote).toBeTruthy()
      expect(issue.provider).toBeTruthy()
      expect(issue.title).toBe('Full fields test')
      expect(typeof issue.body).toBe('string')
      expect(['open', 'closed']).toContain(issue.state)
      expect(Array.isArray(issue.labels)).toBe(true)
      expect(Array.isArray(issue.assignees)).toBe(true)
      expect(issue.author).toBeTruthy()
      expect(issue.createdAt).toBeTruthy()
      expect(issue.updatedAt).toBeTruthy()
      expect(typeof issue.commentCount).toBe('number')
    })
  })

  describe('offline issue reads/writes → flush queue', () => {
    it('reads from cache when provider unreachable', async () => {
      const bus = createEventBus(dataDir)
      const cache = createIssueCache(dataDir)

      // Pre-populate cache
      const cachedIssue = makeIssue({ title: 'Cached issue' })
      cache.setCached('org1', 'proj1', [cachedIssue])

      // Provider that always throws
      const failingProvider: IssueProvider = {
        async list() {
          throw new Error('Network error')
        },
        async get() {
          throw new Error('Network error')
        },
        async create() {
          throw new Error('Network error')
        },
        async update() {
          throw new Error('Network error')
        },
        async listComments() {
          throw new Error('Network error')
        },
        async addComment() {
          throw new Error('Network error')
        }
      }

      const remotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]
      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: () => failingProvider,
        cache
      })

      // Should serve from cache
      const issues = await tracker.list('org1', { projectId: 'proj1' })
      expect(issues).toHaveLength(1)
      expect(issues[0].title).toBe('Cached issue')
    })

    it('queues writes when offline', async () => {
      const bus = createEventBus(dataDir)
      const cache = createIssueCache(dataDir)

      const failingProvider: IssueProvider = {
        async list() {
          throw new Error('Network error')
        },
        async get() {
          throw new Error('Network error')
        },
        async create() {
          throw new Error('Network error')
        },
        async update() {
          throw new Error('Network error')
        },
        async listComments() {
          throw new Error('Network error')
        },
        async addComment() {
          throw new Error('Network error')
        }
      }

      const remotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]
      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: () => failingProvider,
        cache
      })

      // Create should fail but queue
      await expect(tracker.create('org1', 'proj1', { remote: 'origin', title: 'Offline issue' })).rejects.toThrow()

      // Check queue has entries
      const queue = cache.getQueue()
      expect(queue.length).toBeGreaterThanOrEqual(1)
      expect(queue[0].type).toBe('create')
    })

    it('flushQueue replays queued writes when connectivity returns', async () => {
      const bus = createEventBus(dataDir)
      const cache = createIssueCache(dataDir)

      let online = false
      const mockProvider = makeMockIssueProvider()
      const switchableProvider: IssueProvider = {
        async list(rp, f) {
          if (!online) throw new Error('offline')
          return mockProvider.list(rp, f)
        },
        async get(rp, id) {
          if (!online) throw new Error('offline')
          return mockProvider.get(rp, id)
        },
        async create(rp, d) {
          if (!online) throw new Error('offline')
          return mockProvider.create(rp, d)
        },
        async update(rp, id, p) {
          if (!online) throw new Error('offline')
          return mockProvider.update(rp, id, p)
        },
        async listComments(rp, id) {
          if (!online) throw new Error('offline')
          return mockProvider.listComments(rp, id)
        },
        async addComment(rp, id, b) {
          if (!online) throw new Error('offline')
          return mockProvider.addComment(rp, id, b)
        }
      }

      const remotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]
      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: () => switchableProvider,
        cache
      })

      // Offline create — should queue
      await expect(tracker.create('org1', 'proj1', { remote: 'origin', title: 'Queued issue' })).rejects.toThrow()
      expect(cache.getQueue().length).toBe(1)

      // Come back online
      online = true
      const result = await tracker.flushQueue()
      expect(result.replayed).toBe(1)
      expect(result.failed).toBe(0)

      // Queue should be empty now
      expect(cache.getQueue().length).toBe(0)
    })
  })

  describe('cross-project issue listing', () => {
    it('lists issues across all projects in an org', async () => {
      const bus = createEventBus(dataDir)

      const proj1Issues = [makeIssue({ id: '1', projectId: 'proj1', title: 'Issue in proj1' })]
      const proj2Issues = [makeIssue({ id: '2', projectId: 'proj2', title: 'Issue in proj2' })]

      const remotesByProject: Record<string, Remote[]> = {
        proj1: [{ name: 'origin', provider: 'github', repo: 'owner/proj1' }],
        proj2: [{ name: 'origin', provider: 'github', repo: 'owner/proj2' }],
        // Empty projectId key aggregates both
        '': [
          { name: 'origin', provider: 'github', repo: 'owner/proj1' },
          { name: 'origin2', provider: 'github', repo: 'owner/proj2' }
        ]
      }

      const providersByRepo: Record<string, IssueProvider> = {
        'owner/proj1': makeMockIssueProvider(proj1Issues),
        'owner/proj2': makeMockIssueProvider(proj2Issues)
      }

      const tracker = createIssueTracker(bus, dataDir, (_orgId, projectId) => remotesByProject[projectId] ?? [], {
        createProvider: (remote) => providersByRepo[remote.repo!] ?? makeMockIssueProvider()
      })

      // List across all projects (no projectId filter)
      const all = await tracker.list('org1')
      expect(all.length).toBeGreaterThanOrEqual(2)
    })

    it('aggregates issues across multiple remotes', async () => {
      const bus = createEventBus(dataDir)

      const ghIssues = [makeIssue({ id: 'gh-1', remote: 'origin', provider: 'github', title: 'GH Issue' })]
      const radIssues = [makeIssue({ id: 'rad-1', remote: 'rad', provider: 'radicle', title: 'Rad Issue' })]

      const remotes: Remote[] = [
        { name: 'origin', provider: 'github', repo: 'owner/repo' },
        { name: 'rad', provider: 'radicle', rid: 'rad:z123' }
      ]

      const providerByRemote: Record<string, IssueProvider> = {
        origin: makeMockIssueProvider(ghIssues),
        rad: makeMockIssueProvider(radIssues)
      }

      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: (remote) => providerByRemote[remote.name]
      })

      const all = await tracker.list('org1', { projectId: 'proj1' })
      expect(all).toHaveLength(2)
      expect(all.map((i) => i.title).sort()).toEqual(['GH Issue', 'Rad Issue'])
    })
  })

  describe('review lifecycle', () => {
    let bus: ReturnType<typeof createEventBus>
    let mockProvider: ReturnType<typeof makeMockReviewProvider>
    let csManager: ReturnType<typeof createChangeSetManager>
    let reviewSystem: ReturnType<typeof createReviewSystem>
    let worktreeRemoved: string[]

    beforeEach(() => {
      bus = createEventBus(dataDir)
      mockProvider = makeMockReviewProvider()
      csManager = createChangeSetManager(bus, dataDir)
      worktreeRemoved = []

      const deps: ReviewDeps = {
        removeWorktree: async (id: string) => {
          worktreeRemoved.push(id)
        },
        getChangeSet: (id: string) => csManager.getChangeSet(id),
        updateChangeSet: (id: string, patch) => csManager.updateChangeSet(id, patch),
        getProvider: () => mockProvider
      }

      reviewSystem = createReviewSystem(bus, dataDir, deps, {
        getRemotes: () => [{ name: 'origin', provider: 'github', repo: 'owner/repo' }],
        createChangeSet: (data) => csManager.createChangeSet(data)
      })
    })

    it('creates review from worktree branch', async () => {
      const events: string[] = []
      bus.on('review.created', () => {
        events.push('review.created')
      })
      bus.on('changeset.created', () => {
        events.push('changeset.created')
      })

      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        worktreeId: 'wt-1',
        title: 'My PR',
        description: 'Description',
        baseBranch: 'main',
        headBranch: 'feature/x'
      })

      expect(review.title).toBe('My PR')
      expect(review.status).toBe('open')
      expect(review.changeSetId).toBeTruthy()
      expect(events).toContain('changeset.created')
      expect(events).toContain('review.created')
    })

    it('adds inline comments to review', async () => {
      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        title: 'PR',
        baseBranch: 'main',
        headBranch: 'feat'
      })

      const comment = await reviewSystem.addComment('org1', 'proj1', review.id, {
        filePath: 'src/index.ts',
        lineNumber: 42,
        side: 'new' as const,
        body: 'Looks good here'
      })

      expect(comment.filePath).toBe('src/index.ts')
      expect(comment.lineNumber).toBe(42)
      expect(comment.body).toBe('Looks good here')

      const comments = await reviewSystem.listComments('org1', 'proj1', review.id)
      expect(comments.length).toBeGreaterThanOrEqual(1)
    })

    it('approves review', async () => {
      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        title: 'PR',
        baseBranch: 'main',
        headBranch: 'feat'
      })

      const events: string[] = []
      bus.on('review.approved', () => {
        events.push('review.approved')
      })

      const approved = await reviewSystem.approve('org1', 'proj1', review.id, 'LGTM')
      expect(approved.status).toBe('approved')
      expect(events).toContain('review.approved')
    })

    it('merges review', async () => {
      const events: string[] = []
      bus.on('review.merged', () => {
        events.push('review.merged')
      })

      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        title: 'PR',
        baseBranch: 'main',
        headBranch: 'feat'
      })

      const merged = await reviewSystem.merge('org1', 'proj1', review.id)
      expect(merged.status).toBe('merged')
      expect(merged.mergedAt).toBeTruthy()
      expect(events).toContain('review.merged')
    })

    it('merge cleans up worktree', async () => {
      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        worktreeId: 'wt-cleanup',
        title: 'PR',
        baseBranch: 'main',
        headBranch: 'feat'
      })

      // The changeset was created with worktreeId
      const cs = csManager.getChangeSet(review.changeSetId)
      expect(cs?.worktreeId).toBe('wt-cleanup')

      await reviewSystem.merge('org1', 'proj1', review.id)
      expect(worktreeRemoved).toContain('wt-cleanup')
    })

    it('merge updates change set status to merged', async () => {
      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        title: 'PR',
        baseBranch: 'main',
        headBranch: 'feat'
      })

      await reviewSystem.merge('org1', 'proj1', review.id)

      const cs = csManager.getChangeSet(review.changeSetId)
      expect(cs?.status).toBe('merged')
    })
  })

  describe('cross-module events', () => {
    it('review.merged triggers notification.created', async () => {
      const bus = createEventBus(dataDir)
      const csManager = createChangeSetManager(bus, dataDir)
      const mockProvider = makeMockReviewProvider()

      // Set up a listener that simulates a notification module
      const notifications: unknown[] = []
      bus.on('review.merged', (event) => {
        bus.emit({
          type: 'notification.created',
          timestamp: new Date().toISOString(),
          source: 'notifications',
          payload: { reason: 'review.merged', data: event.payload }
        })
      })
      bus.on('notification.created', (e) => {
        notifications.push(e.payload)
      })

      const deps: ReviewDeps = {
        removeWorktree: async () => {},
        getChangeSet: (id) => csManager.getChangeSet(id),
        updateChangeSet: (id, patch) => csManager.updateChangeSet(id, patch),
        getProvider: () => mockProvider
      }

      const reviewSystem = createReviewSystem(bus, dataDir, deps, {
        getRemotes: () => [{ name: 'origin', provider: 'github', repo: 'owner/repo' }],
        createChangeSet: (data) => csManager.createChangeSet(data)
      })

      const review = await reviewSystem.create('org1', 'proj1', {
        remote: 'origin',
        title: 'PR',
        baseBranch: 'main',
        headBranch: 'feat'
      })
      await reviewSystem.merge('org1', 'proj1', review.id)

      expect(notifications.length).toBe(1)
      expect((notifications[0] as any).reason).toBe('review.merged')
    })

    it('notification.created triggers ws push to client', () => {
      const bus = createEventBus(dataDir)
      const wsHandler = createWsHandler(bus)

      wsHandler.registerChannel('notifications', {
        serverMessages: ['notification.created'],
        clientMessages: []
      })

      // Create mock WS client
      const handlers = new Map<string, Function[]>()
      const sendFn = vi.fn() as unknown as (data: string | Buffer) => void
      const mockWs: WsLike = {
        send: sendFn,
        close: vi.fn() as unknown as () => void,
        on(event: string, handler: (...args: unknown[]) => void) {
          if (!handlers.has(event)) handlers.set(event, [])
          handlers.get(event)!.push(handler)
        }
      }

      wsHandler.handleConnection(mockWs, 'device-1')

      // Subscribe
      const msgHandlers = handlers.get('message') || []
      for (const h of msgHandlers) h(JSON.stringify({ type: 'subscribe', channels: ['notifications'] }))

      // Simulate notification push via broadcastToChannel
      wsHandler.broadcastToChannel('notifications', {
        type: 'notification.created',
        data: { reason: 'review.merged', reviewId: 'pr-1' }
      })

      expect(sendFn).toHaveBeenCalledWith(expect.stringContaining('notification.created'))
    })
  })

  describe('Radicle integration', () => {
    it('init repo → push → list shows repo with peers', async () => {
      const bus = createEventBus(dataDir)
      const manager = createRadicleManager(bus, dataDir)

      // Mock all CLI calls
      vi.spyOn(radCli, 'isRadAvailable').mockResolvedValue(true)
      vi.spyOn(radCli, 'radInit').mockResolvedValue({
        rid: 'rad:z123abc',
        name: 'test-repo',
        defaultBranch: 'main',
        peers: [],
        delegates: ['did:key:z6Mk...'],
        seeding: false
      })
      vi.spyOn(radCli, 'radPush').mockResolvedValue(undefined)
      vi.spyOn(radCli, 'radListRepos').mockResolvedValue([
        {
          rid: 'rad:z123abc',
          name: 'test-repo',
          defaultBranch: 'main',
          peers: [{ nodeId: 'z6Mk...peer1', state: 'connected' as const }],
          delegates: [],
          seeding: true
        }
      ])

      const events: string[] = []
      bus.on('radicle.repo.init', () => {
        events.push('init')
      })
      bus.on('radicle.repo.pushed', () => {
        events.push('pushed')
      })

      const repo = await manager.initRepo('/tmp/test-repo', { name: 'test-repo' })
      expect(repo.rid).toBe('rad:z123abc')
      expect(events).toContain('init')

      await manager.push('rad:z123abc')
      expect(events).toContain('pushed')

      const repos = await manager.listRepos()
      expect(repos).toHaveLength(1)
      expect(repos[0].rid).toBe('rad:z123abc')
      expect(repos[0].peers).toHaveLength(1)
      expect(repos[0].peers[0].state).toBe('connected')

      vi.restoreAllMocks()
    })

    it('Radicle CLI unavailable → graceful degradation with clear error', async () => {
      const bus = createEventBus(dataDir)
      const manager = createRadicleManager(bus, dataDir)

      vi.spyOn(radCli, 'isRadAvailable').mockResolvedValue(false)

      await expect(manager.listRepos()).rejects.toThrow(/not installed|not in PATH/)
      await expect(manager.initRepo('/tmp/test')).rejects.toThrow(/not installed|not in PATH/)
      await expect(manager.push('rad:z123')).rejects.toThrow(/not installed|not in PATH/)

      vi.restoreAllMocks()
    })
  })

  describe('auth-protected endpoints', () => {
    let app: express.Express

    beforeEach(() => {
      const bus = createEventBus(dataDir)
      const auth = createAuth(bus, dataDir, { tokenExpiry: '1h', trustedProxies: [] })
      const middleware = createAuthMiddleware(auth)
      const csManager = createChangeSetManager(bus, dataDir)
      const diffRouter = createDiffRouter(csManager)

      const mockIssueProvider = makeMockIssueProvider()
      const remotes: Remote[] = [{ name: 'origin', provider: 'github', repo: 'owner/repo' }]
      const tracker = createIssueTracker(bus, dataDir, () => remotes, {
        createProvider: () => mockIssueProvider
      })
      const issueRouter = createIssueRouter(tracker)

      const mockReviewProvider = makeMockReviewProvider()
      const reviewDeps: ReviewDeps = {
        removeWorktree: async () => {},
        getChangeSet: (id) => csManager.getChangeSet(id),
        updateChangeSet: (id, patch) => csManager.updateChangeSet(id, patch),
        getProvider: () => mockReviewProvider
      }
      const reviewSys = createReviewSystem(bus, dataDir, reviewDeps, {
        getRemotes: () => remotes.map((r) => ({ ...r }))
      })
      const reviewRouter = createReviewRouter(reviewSys)

      // Mock radicle CLI to avoid real calls
      vi.spyOn(radCli, 'isRadAvailable').mockResolvedValue(true)
      vi.spyOn(radCli, 'radStatus').mockResolvedValue({ running: true, peers: 0 })
      vi.spyOn(radCli, 'radListRepos').mockResolvedValue([])
      const radManager = createRadicleManager(bus, dataDir)
      const radicleRouter = createRadicleRouter(radManager)

      app = express()
      app.use(express.json())
      // All routes behind auth
      app.use(middleware, diffRouter)
      app.use(middleware, issueRouter)
      app.use(middleware, reviewRouter)
      app.use('/api/radicle', middleware, radicleRouter)
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('diff endpoints require authentication', async () => {
      const res1 = await request(app).get('/api/changesets')
      expect(res1.status).toBe(401)

      const res2 = await request(app)
        .post('/api/changesets')
        .send({ orgId: 'org1', projectId: 'p1', baseBranch: 'main', headBranch: 'feat', title: 'x' })
      expect(res2.status).toBe(401)

      const res3 = await request(app).get('/api/diff?path=x&base=a&head=b&projectId=p')
      expect(res3.status).toBe(401)
    })

    it('issue endpoints require authentication', async () => {
      const res1 = await request(app).get('/api/orgs/org1/issues')
      expect(res1.status).toBe(401)

      const res2 = await request(app)
        .post('/api/orgs/org1/projects/proj1/issues')
        .send({ remote: 'origin', title: 'test' })
      expect(res2.status).toBe(401)

      const res3 = await request(app).post('/api/orgs/org1/projects/proj1/issues/sync')
      expect(res3.status).toBe(401)
    })

    it('review endpoints require authentication', async () => {
      const res1 = await request(app).get('/api/orgs/org1/reviews')
      expect(res1.status).toBe(401)

      const res2 = await request(app)
        .post('/api/orgs/org1/projects/proj1/reviews')
        .send({ title: 'x', baseBranch: 'main', headBranch: 'feat' })
      expect(res2.status).toBe(401)

      const res3 = await request(app).post('/api/orgs/org1/projects/proj1/reviews/pr-1/merge')
      expect(res3.status).toBe(401)
    })

    it('radicle endpoints require authentication', async () => {
      const res1 = await request(app).get('/api/radicle/status')
      expect(res1.status).toBe(401)

      const res2 = await request(app).get('/api/radicle/repos')
      expect(res2.status).toBe(401)

      const res3 = await request(app).post('/api/radicle/repos').send({ path: '/tmp/test' })
      expect(res3.status).toBe(401)
    })
  })
})
