// Membranes — JSON store
//
// File location: `<dataDir>/membranes.json`. Flat file (not a directory)
// because membranes are a small set of declarative entries — the index
// belongs at the root of `data/` alongside other top-level indices we may
// add later (threads.json, workspaces.json).

import fs from 'node:fs'
import path from 'node:path'
import type { MembranesData } from './types.js'

export interface MembraneStore {
  read(): MembranesData
  write(data: MembranesData): void
  /** Absolute path to the JSON file (useful for migrations and tests). */
  filePath: string
}

const empty = (): MembranesData => ({ version: 1, membranes: [] })

export function createMembraneStore(dataDir: string): MembraneStore {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const filePath = path.join(dataDir, 'membranes.json')

  const read = (): MembranesData => {
    if (!fs.existsSync(filePath)) return empty()
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      // Tolerate older / handcrafted files missing `version`. Any
      // legacy `activeMembraneId` field is silently dropped — it's no
      // longer part of the schema (UI state moved out).
      if (!parsed || typeof parsed !== 'object') return empty()
      return {
        version: 1,
        membranes: Array.isArray(parsed.membranes) ? parsed.membranes : []
      }
    } catch {
      return empty()
    }
  }

  const write = (data: MembranesData): void => {
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, filePath)
  }

  return { read, write, filePath }
}
