// Sovereign-owned thread/session registry. Persists the binding between a
// logical thread key, the backend that owns it, and the backend-internal
// session identifier. This is the *only* place outside an adapter that
// records that mapping — modules that need to find sessions go through
// `AgentBackend.listSessions()` and the registry, never through backend
// implementation files.

import fs from 'node:fs'
import path from 'node:path'
import type { AgentBackendKind } from '@sovereign/core'

export interface ThreadSessionRecord {
  threadKey: string
  /** Canonical session key Sovereign uses for routing. */
  sessionKey: string
  backendKind: AgentBackendKind
  /** Backend-internal id (Pi UUID, Claude Code UUID). */
  backendSessionId?: string
  /** Optional path to the backend's JSONL file, if any. */
  backendSessionFile?: string
  createdAt: number
  updatedAt: number
  label?: string
  /** For subagent sessions: key of the parent session. */
  parentSessionKey?: string
  /** Org binding (drives per-org CLAUDE.md layering + per-org tool policy). */
  orgId?: string
  /** Per-session cwd override; falls back to the backend's default cwd. */
  cwd?: string
  /** Backend-specific model id last selected for this session. */
  model?: string
}

export interface SessionsRegistry {
  /** Look up by either logical thread key or canonical session key. */
  get(key: string): ThreadSessionRecord | undefined
  getByThread(threadKey: string): ThreadSessionRecord | undefined
  getBySession(sessionKey: string): ThreadSessionRecord | undefined
  /** Insert or update a record. */
  upsert(record: Omit<ThreadSessionRecord, 'createdAt' | 'updatedAt'> & { createdAt?: number }): ThreadSessionRecord
  /** Remove a record by thread key. */
  remove(threadKey: string): void
  /** List all records, optionally filtered. */
  list(filter?: { backendKind?: AgentBackendKind; parentSessionKey?: string }): ThreadSessionRecord[]
  /** Flush any pending writes synchronously. */
  flush(): void
}

interface Options {
  /** Debounce interval for atomic writes. Default 250ms. */
  debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 250

export function createSessionsRegistry(dataDir: string, options: Options = {}): SessionsRegistry {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const filePath = path.join(dataDir, 'agent-backend', 'sessions.json')
  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })

  // Keyed by threadKey for primary storage; a parallel index lets us look up
  // by canonical session key in O(1).
  const records = new Map<string, ThreadSessionRecord>()
  const byCanonical = new Map<string, string>() // sessionKey -> threadKey

  // Load existing file
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, ThreadSessionRecord>
    for (const [threadKey, record] of Object.entries(parsed)) {
      records.set(threadKey, record)
      if (record.sessionKey) byCanonical.set(record.sessionKey, threadKey)
    }
  } catch {
    // Empty registry
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleWrite(): void {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      writeNow()
    }, debounceMs)
  }

  function writeNow(): void {
    try {
      const obj: Record<string, ThreadSessionRecord> = {}
      for (const [k, v] of records) obj[k] = v
      // Re-create the parent dir defensively — it may have been removed
      // since registry construction (tests, manual workspace cleanup).
      fs.mkdirSync(dirPath, { recursive: true })
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
      fs.renameSync(tmp, filePath)
    } catch {
      // Best-effort: a missing parent dir means the consumer is tearing
      // down. Drop the write silently rather than throw from a setTimeout
      // callback which would become an unhandled exception.
    }
  }

  return {
    get(key) {
      return (records.get(key) ?? byCanonical.get(key)) ? records.get(byCanonical.get(key) ?? key) : undefined
    },
    getByThread(threadKey) {
      return records.get(threadKey)
    },
    getBySession(sessionKey) {
      const tk = byCanonical.get(sessionKey)
      return tk ? records.get(tk) : undefined
    },
    upsert(input) {
      const now = Date.now()
      const existing = records.get(input.threadKey)
      const record: ThreadSessionRecord = {
        threadKey: input.threadKey,
        sessionKey: input.sessionKey,
        backendKind: input.backendKind,
        backendSessionId: input.backendSessionId,
        backendSessionFile: input.backendSessionFile,
        label: input.label,
        parentSessionKey: input.parentSessionKey,
        orgId: input.orgId ?? existing?.orgId,
        cwd: input.cwd ?? existing?.cwd,
        model: input.model ?? existing?.model,
        createdAt: existing?.createdAt ?? input.createdAt ?? now,
        updatedAt: now
      }
      records.set(record.threadKey, record)
      if (record.sessionKey) byCanonical.set(record.sessionKey, record.threadKey)
      scheduleWrite()
      return record
    },
    remove(threadKey) {
      const existing = records.get(threadKey)
      if (existing?.sessionKey) byCanonical.delete(existing.sessionKey)
      records.delete(threadKey)
      scheduleWrite()
    },
    list(filter) {
      const all = [...records.values()]
      if (!filter) return all
      return all.filter((r) => {
        if (filter.backendKind && r.backendKind !== filter.backendKind) return false
        if (filter.parentSessionKey && r.parentSessionKey !== filter.parentSessionKey) return false
        return true
      })
    },
    flush() {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      writeNow()
    }
  }
}
