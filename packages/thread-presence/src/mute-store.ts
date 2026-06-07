// MuteStore — persistent per-thread notification mutes.
//
// Stored on disk at <dataDir>/thread-presence/mutes.json so the user's choice
// to silence a noisy thread survives daemon restarts. The file format is a
// minimal `{ mutedThreadIds: string[] }` — a flat list is enough; we don't
// need per-thread expiry or schedules at this stage.

import * as fs from 'node:fs'
import * as path from 'node:path'

const FILE_NAME = 'mutes.json'

export interface MuteStore {
  isMuted(threadId: string): boolean
  mute(threadId: string): boolean
  unmute(threadId: string): boolean
  list(): string[]
  setAll(threadIds: string[]): void
}

function atomicWrite(filePath: string, data: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, data, 'utf-8')
  fs.renameSync(tmp, filePath)
}

export function createMuteStore(dataDir: string): MuteStore {
  const filePath = path.join(dataDir, 'thread-presence', FILE_NAME)
  const muted = new Set<string>()

  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      const ids: unknown = parsed?.mutedThreadIds
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'string' && id) muted.add(id)
        }
      }
    } catch {
      /* tolerate corrupt file */
    }
  }

  const persist = (): void => {
    atomicWrite(filePath, JSON.stringify({ mutedThreadIds: [...muted].sort() }, null, 2))
  }

  const isMuted = (id: string): boolean => muted.has(id)

  const mute = (id: string): boolean => {
    if (!id || muted.has(id)) return false
    muted.add(id)
    persist()
    return true
  }

  const unmute = (id: string): boolean => {
    if (!muted.delete(id)) return false
    persist()
    return true
  }

  const list = (): string[] => [...muted].sort()

  const setAll = (ids: string[]): void => {
    muted.clear()
    for (const id of ids) if (typeof id === 'string' && id) muted.add(id)
    persist()
  }

  return { isMuted, mute, unmute, list, setAll }
}
