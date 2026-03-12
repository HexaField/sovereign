// Core review system

import type { EventBus } from '@template/core'
import type { Review, ReviewComment, ReviewSystem, ReviewDeps, ReviewProvider } from './types.js'
import { createReviewCache, type ReviewCache } from './cache.js'
import { createMergeHandler, type MergeHandler } from './merge.js'

export type GetRemotes = (
  orgId: string,
  projectId: string
) => Array<{ name: string; provider: 'github' | 'radicle'; repo?: string; rid?: string }>

export interface ReviewSystemOptions {
  cache?: ReviewCache
  getRemotes: GetRemotes
  createChangeSet?: (data: {
    orgId: string
    projectId: string
    worktreeId?: string
    baseBranch: string
    headBranch: string
    title: string
    description?: string
  }) => Promise<{ id: string }>
  pushBranch?: (orgId: string, projectId: string, branch: string, remote: string) => Promise<void>
}

export function createReviewSystem(
  bus: EventBus,
  dataDir: string,
  deps: ReviewDeps,
  opts?: ReviewSystemOptions
): ReviewSystem {
  const cache = opts?.cache ?? createReviewCache(dataDir)
  const mergeHandler: MergeHandler = createMergeHandler(bus, deps)

  function emitEvent(type: string, payload: unknown): void {
    bus.emit({ type, timestamp: new Date().toISOString(), source: 'review', payload })
  }

  function getProvider(orgId: string, projectId: string): ReviewProvider {
    return deps.getProvider(orgId, projectId)
  }

  const system: ReviewSystem = {
    async create(orgId, projectId, data): Promise<Review> {
      const provider = getProvider(orgId, projectId)

      // Create change set if createChangeSet is available
      let changeSetId = ''
      if (opts?.createChangeSet) {
        const cs = await opts.createChangeSet({
          orgId,
          projectId,
          worktreeId: data.worktreeId,
          baseBranch: data.baseBranch,
          headBranch: data.headBranch,
          title: data.title,
          description: data.description
        })
        changeSetId = cs.id
      }

      // Push branch if pushBranch is available
      if (opts?.pushBranch) {
        try {
          await opts.pushBranch(orgId, projectId, data.headBranch, data.remote)
        } catch {
          // Branch may already be pushed
        }
      }

      // Create PR/patch via provider
      const review = await provider.create('', {
        title: data.title,
        body: data.description,
        baseBranch: data.baseBranch,
        headBranch: data.headBranch
      })

      review.changeSetId = changeSetId

      // Cache it
      const existing = cache.getCached(orgId, projectId) ?? []
      cache.setCached(orgId, projectId, [...existing, review])

      emitEvent('review.created', review)
      return review
    },

    async get(orgId, projectId, reviewId): Promise<Review | undefined> {
      // Try provider first
      try {
        const provider = getProvider(orgId, projectId)
        const review = await provider.get('', reviewId)
        if (review) return review
      } catch {
        // Provider unreachable — fall through to cache
      }

      // Serve from cache
      const cached = cache.getCached(orgId, projectId)
      return cached?.find((r) => r.id === reviewId)
    },

    async list(orgId, filter?): Promise<Review[]> {
      const projectId = filter?.projectId ?? ''
      try {
        const provider = getProvider(orgId, projectId)
        const reviews = await provider.list('', filter ? { status: filter.status } : undefined)
        cache.setCached(orgId, projectId, reviews)
        return reviews
      } catch {
        // Offline — serve from cache
        let cached = cache.getCached(orgId, projectId) ?? []
        if (filter?.status) {
          cached = cached.filter((r) => r.status === filter.status)
        }
        return cached
      }
    },

    async addComment(orgId, projectId, reviewId, comment): Promise<ReviewComment> {
      const provider = getProvider(orgId, projectId)
      const rc = await provider.addComment('', reviewId, {
        filePath: comment.filePath,
        lineNumber: comment.lineNumber,
        body: comment.body,
        side: comment.side
      })
      emitEvent('review.comment.added', { orgId, projectId, reviewId, comment: rc })
      return rc
    },

    async listComments(orgId, projectId, reviewId): Promise<ReviewComment[]> {
      const provider = getProvider(orgId, projectId)
      return provider.listComments('', reviewId)
    },

    async resolveComment(orgId, projectId, reviewId, commentId): Promise<void> {
      const provider = getProvider(orgId, projectId)
      await provider.resolveComment('', reviewId, commentId)
      emitEvent('review.comment.resolved', { orgId, projectId, reviewId, commentId })
    },

    async approve(orgId, projectId, reviewId, body?): Promise<Review> {
      const provider = getProvider(orgId, projectId)
      await provider.approve('', reviewId, body)

      const review = await provider.get('', reviewId)
      const updated = review ?? ({ id: reviewId, status: 'approved' as const } as Review)

      // Update cache
      const cached = cache.getCached(orgId, projectId) ?? []
      const idx = cached.findIndex((r) => r.id === reviewId)
      if (idx >= 0) {
        cached[idx] = updated
        cache.setCached(orgId, projectId, cached)
      }

      emitEvent('review.approved', { orgId, projectId, reviewId })
      return updated
    },

    async requestChanges(orgId, projectId, reviewId, body): Promise<Review> {
      const provider = getProvider(orgId, projectId)
      await provider.requestChanges('', reviewId, body)

      const review = await provider.get('', reviewId)
      const updated = review ?? ({ id: reviewId, status: 'changes_requested' as const } as Review)

      const cached = cache.getCached(orgId, projectId) ?? []
      const idx = cached.findIndex((r) => r.id === reviewId)
      if (idx >= 0) {
        cached[idx] = updated
        cache.setCached(orgId, projectId, cached)
      }

      emitEvent('review.changes_requested', { orgId, projectId, reviewId })
      return updated
    },

    async merge(orgId, projectId, reviewId): Promise<Review> {
      const review = await system.get(orgId, projectId, reviewId)
      if (!review) throw new Error(`Review ${reviewId} not found`)

      await mergeHandler.merge(orgId, projectId, reviewId, review)

      const merged: Review = { ...review, status: 'merged', mergedAt: new Date().toISOString() }

      const cached = cache.getCached(orgId, projectId) ?? []
      const idx = cached.findIndex((r) => r.id === reviewId)
      if (idx >= 0) {
        cached[idx] = merged
        cache.setCached(orgId, projectId, cached)
      }

      return merged
    },

    async sync(orgId, projectId): Promise<{ synced: number; errors: number }> {
      let synced = 0
      let errors = 0
      try {
        const provider = getProvider(orgId, projectId)
        const reviews = await provider.list('')
        cache.setCached(orgId, projectId, reviews)
        synced = reviews.length
      } catch {
        errors++
      }
      emitEvent('review.synced', { orgId, projectId, synced, errors })
      return { synced, errors }
    }
  }

  return system
}
