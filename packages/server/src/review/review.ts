// Core review system

import type { EventBus } from '@template/core'
import type { ReviewSystem, ReviewDeps } from './types.js'

export function createReviewSystem(_bus: EventBus, _dataDir: string, _deps: ReviewDeps): ReviewSystem {
  throw new Error('not implemented')
}
