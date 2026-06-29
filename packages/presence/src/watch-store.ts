// WatchStore — persistent list of thread ids the presence agent is watching.
// Backs the `presence_watch` / `presence_unwatch` / `presence_watched` MCP
// tools and the digest service's filter. See R6 in
// plans/presence-thread-spec.md.

import fs from 'node:fs'
import path from 'node:path'

export interface WatchEntry {
  threadId: string
  /** Optional human-readable note about why the agent is watching this thread. */
  reason?: string
  /** ISO timestamp of when this entry was added. */
  addedAt: string
}

export interface WatchStore {
  add(threadId: string, reason?: string): WatchEntry
  remove(threadId: string): boolean
  has(threadId: string): boolean
  list(): WatchEntry[]
  /** Flush pending writes synchronously. Called on shutdown. */
  flush(): void
}

const FILE_NAME = 'presence-watched.json'

export function createWatchStore(dataDir: string): WatchStore {
  const filePath = path.join(dataDir, FILE_NAME)
  const entries = new Map<string, WatchEntry>()

  // Load existing list (best-effort — corrupt file = empty start).
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as WatchEntry[]
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (e && typeof e.threadId === 'string') entries.set(e.threadId, e)
      }
    }
  } catch {
    /* empty */
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleWrite(): void {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      flushNow()
    }, 250)
  }

  function flushNow(): void {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify([...entries.values()], null, 2))
      fs.renameSync(tmp, filePath)
    } catch (err) {
      console.warn('[presence] watch-store: persist failed:', (err as Error)?.message)
    }
  }

  return {
    add(threadId, reason) {
      const existing = entries.get(threadId)
      const entry: WatchEntry = existing
        ? { ...existing, reason: reason ?? existing.reason }
        : { threadId, reason, addedAt: new Date().toISOString() }
      entries.set(threadId, entry)
      scheduleWrite()
      return entry
    },
    remove(threadId) {
      const had = entries.delete(threadId)
      if (had) scheduleWrite()
      return had
    },
    has(threadId) {
      return entries.has(threadId)
    },
    list() {
      return [...entries.values()]
    },
    flush() {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      flushNow()
    }
  }
}
