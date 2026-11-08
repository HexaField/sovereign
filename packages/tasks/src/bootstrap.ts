// Forge persistence bootstrap — the task store and the Forge meta store on
// the `sovereign-forge` AD4M perspective, both resilient to AD4M being down.
//
// The old `hex-tasks` perspective is not read or migrated (clean slate).
//
// Files under <dataDir>/tasks/:
//   forge-perspective.json        cached perspective uuid
//   outbox.jsonl, snapshot.json   task store
//   meta-outbox.jsonl, meta-snapshot.json   views + related edges

import type { Ad4mClientManager } from '@sovereign/ad4m'
import { createForgePerspective } from './ad4m-perspective.js'
import type { ForgeMetaStore } from './meta.js'
import { createForgeMetaStore } from './meta.js'
import type { TaskStore } from './store.js'
import { createResilientTaskStore, taskStoreDir } from './store.js'

export interface ForgePersistenceOptions {
  /** The server's AD4M client manager; undefined = AD4M not configured (local snapshot only). */
  ad4m?: Ad4mClientManager
  /** Sovereign data dir; files go to <dataDir>/tasks. */
  dataDir: string
  /** Perspective name override (tests). */
  perspectiveName?: string
  retryMs?: number
}

export interface ForgePersistence {
  taskStore: TaskStore
  meta: ForgeMetaStore
  dispose(): void
}

export function createForgePersistence(opts: ForgePersistenceOptions): ForgePersistence {
  const dir = taskStoreDir(opts.dataDir)
  const perspective = opts.ad4m
    ? createForgePerspective({ ad4m: opts.ad4m, dataDir: dir, name: opts.perspectiveName })
    : null
  const shared = {
    dir,
    connect: perspective ? () => perspective.connect() : null,
    onReconnect: perspective ? (cb: () => void) => perspective.onReconnect(cb) : undefined,
    retryMs: opts.retryMs
  }
  const taskStore = createResilientTaskStore(shared)
  const meta = createForgeMetaStore(shared)
  return {
    taskStore,
    meta,
    dispose() {
      taskStore.dispose()
      meta.dispose()
    }
  }
}
