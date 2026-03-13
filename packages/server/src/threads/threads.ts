// Threads — Thread Registry, auto-creation, entity management

import type { EventBus } from '@template/core'

export interface ThreadManagerDeps {
  dataDir: string
}

export function createThreadManager(_bus: EventBus, _dataDir: string, _deps: ThreadManagerDeps): unknown {
  throw new Error('not implemented')
}
