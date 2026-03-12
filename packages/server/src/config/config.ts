// Core config store

import type { EventBus, ModuleStatus } from '@template/core'
import type { ConfigStore } from './types.js'

export function createConfigStore(_bus: EventBus, _dataDir: string): ConfigStore {
  throw new Error('not implemented')
}

export function status(): ModuleStatus {
  return { name: 'config', status: 'ok' }
}
