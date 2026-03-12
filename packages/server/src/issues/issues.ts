// Core issue tracker

import type { EventBus } from '@template/core'
import type { IssueTracker } from './types.js'

export function createIssueTracker(_bus: EventBus, _dataDir: string, _config: unknown): IssueTracker {
  throw new Error('not implemented')
}
