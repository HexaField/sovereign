// Config change history (JSONL append)

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ConfigChange } from './types.js'

export function createHistory(dataDir: string) {
  const filePath = path.join(dataDir, 'config-history.jsonl')

  const ensureDir = () => {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  return {
    append(change: ConfigChange): void {
      ensureDir()
      fs.appendFileSync(filePath, JSON.stringify(change) + '\n')
    },

    list(opts?: { limit?: number; offset?: number }): ConfigChange[] {
      if (!fs.existsSync(filePath)) return []
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
      const all = lines.map((l) => JSON.parse(l) as ConfigChange)
      const offset = opts?.offset ?? 0
      const limit = opts?.limit ?? all.length
      return all.slice(offset, offset + limit)
    }
  }
}
