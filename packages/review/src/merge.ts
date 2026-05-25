// Merge orchestration

import type { EventBus } from '@sovereign/core'
import type { Review, ReviewDeps } from './types.js'

export interface MergeHandler {
  merge(orgId: string, projectId: string, reviewId: string, review: Review): Promise<void>
}

export function createMergeHandler(bus: EventBus, deps: ReviewDeps): MergeHandler {
  return {
    async merge(orgId: string, projectId: string, reviewId: string, review: Review): Promise<void> {
      // 1. Call provider merge
      const provider = deps.getProvider(orgId, projectId)
      const repoPath = '' // Provider uses its own config for repo path
      await provider.merge(repoPath, reviewId)

      // 2. Update change set status to 'merged'
      if (review.changeSetId) {
        const cs = deps.getChangeSet(review.changeSetId)
        if (cs) {
          try {
            deps.updateChangeSet(review.changeSetId, { status: 'merged' })
          } catch {
            // Log but don't fail merge if changeset update fails
          }
        }
      }

      // 3. Clean up worktree if linked
      const cs = review.changeSetId ? deps.getChangeSet(review.changeSetId) : undefined
      if (cs?.worktreeId) {
        try {
          await deps.removeWorktree(cs.worktreeId)
        } catch {
          // Worktree removal failure should not fail the merge
        }
      }

      // 4. Emit review.merged on bus
      bus.emit({
        type: 'review.merged',
        timestamp: new Date().toISOString(),
        source: 'review',
        payload: { orgId, projectId, reviewId, changeSetId: review.changeSetId }
      })
    }
  }
}
