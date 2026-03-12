import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMergeHandler } from './merge.js'
import type { Review, ReviewDeps, ReviewProvider } from './types.js'
import type { EventBus, BusEvent } from '@template/core'

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

function createMockProvider(overrides?: Partial<ReviewProvider>): ReviewProvider {
  return {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    approve: vi.fn(),
    requestChanges: vi.fn(),
    merge: vi.fn(async () => {}),
    addComment: vi.fn(),
    listComments: vi.fn(),
    resolveComment: vi.fn(),
    ...overrides
  }
}

const sampleReview: Review = {
  id: '42',
  changeSetId: 'cs1',
  projectId: 'proj1',
  orgId: 'org1',
  remote: 'origin',
  provider: 'github',
  title: 'Test',
  description: '',
  status: 'open',
  author: 'alice',
  reviewers: [],
  baseBranch: 'main',
  headBranch: 'feat',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}

describe('MergeHandler', () => {
  let bus: ReturnType<typeof createMockBus>
  let mockProvider: ReviewProvider

  beforeEach(() => {
    bus = createMockBus()
    mockProvider = createMockProvider()
  })

  describe('merge', () => {
    it('calls provider merge (gh pr merge / rad patch merge)', async () => {
      const deps: ReviewDeps = {
        removeWorktree: vi.fn(),
        getChangeSet: vi.fn(() => ({
          id: 'cs1',
          worktreeId: undefined,
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
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(mockProvider.merge).toHaveBeenCalledWith('', '42')
    })

    it('cleans up local worktree via injected removeWorktree', async () => {
      const removeWorktree = vi.fn(async () => {})
      const deps: ReviewDeps = {
        removeWorktree,
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
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(removeWorktree).toHaveBeenCalledWith('wt1')
    })

    it('updates change set status to "merged" via injected updateChangeSet', async () => {
      const updateChangeSet = vi.fn((id: string, patch: any) => ({ id, ...patch }))
      const deps: ReviewDeps = {
        removeWorktree: vi.fn(),
        getChangeSet: vi.fn(() => ({
          id: 'cs1',
          worktreeId: undefined,
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
        updateChangeSet,
        getProvider: vi.fn(() => mockProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(updateChangeSet).toHaveBeenCalledWith('cs1', { status: 'merged' })
    })

    it('emits review.merged event on the bus', async () => {
      const deps: ReviewDeps = {
        removeWorktree: vi.fn(),
        getChangeSet: vi.fn(() => undefined),
        updateChangeSet: vi.fn(),
        getProvider: vi.fn(() => mockProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(bus.events).toHaveLength(1)
      expect(bus.events[0].type).toBe('review.merged')
    })
  })

  describe('cleanup on merge', () => {
    it('removes worktree if linked', async () => {
      const removeWorktree = vi.fn(async () => {})
      const deps: ReviewDeps = {
        removeWorktree,
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
        updateChangeSet: vi.fn((id, patch) => ({ id, ...patch }) as any),
        getProvider: vi.fn(() => mockProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(removeWorktree).toHaveBeenCalledWith('wt1')
    })

    it('skips worktree removal if no worktreeId', async () => {
      const removeWorktree = vi.fn()
      const deps: ReviewDeps = {
        removeWorktree,
        getChangeSet: vi.fn(() => ({
          id: 'cs1',
          worktreeId: undefined,
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
        updateChangeSet: vi.fn((id, patch) => ({ id, ...patch }) as any),
        getProvider: vi.fn(() => mockProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(removeWorktree).not.toHaveBeenCalled()
    })

    it('updates change set status even if worktree removal fails', async () => {
      const updateChangeSet = vi.fn((id: string, patch: any) => ({ id, ...patch }))
      const deps: ReviewDeps = {
        removeWorktree: vi.fn(async () => {
          throw new Error('fail')
        }),
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
        updateChangeSet,
        getProvider: vi.fn(() => mockProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await handler.merge('org1', 'proj1', '42', sampleReview)
      expect(updateChangeSet).toHaveBeenCalledWith('cs1', { status: 'merged' })
      // Should still emit event
      expect(bus.events).toHaveLength(1)
    })
  })

  describe('error handling', () => {
    it('propagates provider merge errors', async () => {
      const failProvider = createMockProvider({
        merge: vi.fn(async () => {
          throw new Error('merge failed')
        })
      })
      const deps: ReviewDeps = {
        removeWorktree: vi.fn(),
        getChangeSet: vi.fn(),
        updateChangeSet: vi.fn(),
        getProvider: vi.fn(() => failProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await expect(handler.merge('org1', 'proj1', '42', sampleReview)).rejects.toThrow('merge failed')
    })

    it('handles missing change set gracefully', async () => {
      const deps: ReviewDeps = {
        removeWorktree: vi.fn(),
        getChangeSet: vi.fn(() => undefined),
        updateChangeSet: vi.fn(),
        getProvider: vi.fn(() => mockProvider)
      }
      const handler = createMergeHandler(bus, deps)
      await expect(handler.merge('org1', 'proj1', '42', sampleReview)).resolves.toBeUndefined()
    })
  })
})
