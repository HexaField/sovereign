// Change set management

import type { EventBus } from '@template/core'
import type { DiffEngine } from './types.js'

export interface ChangeSetManager extends Pick<
  DiffEngine,
  'createChangeSet' | 'getChangeSet' | 'listChangeSets' | 'updateChangeSet' | 'deleteChangeSet' | 'getChangeSetFileDiff'
> {}

export function createChangeSetManager(_bus: EventBus, _dataDir: string): ChangeSetManager {
  throw new Error('not implemented')
}
