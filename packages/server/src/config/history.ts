// Config change history (JSONL append)

import type { ConfigChange } from './types.js'

export function createHistory(_dataDir: string): {
  append(change: ConfigChange): void
  list(opts?: { limit?: number; offset?: number }): ConfigChange[]
} {
  throw new Error('not implemented')
}
