// Merge orchestration

import type { EventBus } from '@template/core'
import type { ReviewDeps } from './types.js'

export interface MergeHandler {
  merge(orgId: string, projectId: string, reviewId: string): Promise<void>
}

export function createMergeHandler(_bus: EventBus, _deps: ReviewDeps): MergeHandler {
  throw new Error('not implemented')
}
