// Manages `~/.claude/CLAUDE.md` workspace-folder index. Sovereign owns a
// fenced block inside the file; user content outside the fence is preserved
// verbatim. Writes are debounced + atomic + lockfile-guarded so concurrent
// interactive `claude` use doesn't race us.

import fs from 'node:fs'
import path from 'node:path'

const FENCE_BEGIN = '<!-- BEGIN sovereign-workspaces (managed by Sovereign — do not edit by hand) -->'
const FENCE_END = '<!-- END sovereign-workspaces -->'

export interface WorkspaceEntry {
  /** Absolute path to the workspace folder. */
  path: string
  /** Optional one-line purpose, e.g. "sovereign monorepo". */
  description?: string
  /** Optional org binding to surface alongside. */
  orgId?: string
}

export interface WorkspaceIndex {
  /** Replace the full workspace list and schedule a write. */
  setEntries(entries: WorkspaceEntry[]): void
  /** Get the current in-memory entries. */
  getEntries(): WorkspaceEntry[]
  /** Flush any pending write synchronously. */
  flush(): void
  /** Stop the manager. */
  dispose(): void
}

export interface WorkspaceIndexOptions {
  /** Path to `~/.claude/CLAUDE.md` (or a test override). */
  filePath: string
  /** Debounce interval. Default 500ms. */
  debounceMs?: number
  /** Lockfile path. Defaults to `${filePath}.sovereign.lock`. */
  lockPath?: string
}

const DEFAULT_DEBOUNCE_MS = 500

export function createWorkspaceIndex(options: WorkspaceIndexOptions): WorkspaceIndex {
  const filePath = options.filePath
  const lockPath = options.lockPath ?? `${filePath}.sovereign.lock`
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS

  let entries: WorkspaceEntry[] = []
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleWrite() {
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      writeNow()
    }, debounceMs)
  }

  function withLock<T>(fn: () => T): T {
    const dir = path.dirname(lockPath)
    fs.mkdirSync(dir, { recursive: true })
    // Spin briefly on EEXIST; the lock is held just long enough to rewrite the
    // file. If we still can't acquire after ~500ms, force-take it — a stale
    // lock from a crashed process shouldn't block writes forever.
    const deadline = Date.now() + 500
    while (Date.now() < deadline) {
      try {
        const fd = fs.openSync(lockPath, 'wx')
        try {
          fs.writeSync(fd, String(process.pid))
        } finally {
          fs.closeSync(fd)
        }
        try {
          return fn()
        } finally {
          try {
            fs.unlinkSync(lockPath)
          } catch {
            /* lock already gone */
          }
        }
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err
        // Brief synchronous sleep
        const until = Date.now() + 25
        while (Date.now() < until) {
          /* spin */
        }
      }
    }
    // Force-take after deadline (best effort).
    try {
      fs.unlinkSync(lockPath)
    } catch {
      /* ignore */
    }
    return fn()
  }

  function writeNow() {
    try {
      withLock(() => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        let existing = ''
        try {
          existing = fs.readFileSync(filePath, 'utf-8')
        } catch {
          existing = ''
        }
        const block = buildBlock(entries)
        const fenceRegex = new RegExp(`${escapeRegex(FENCE_BEGIN)}[\\s\\S]*?${escapeRegex(FENCE_END)}\\n?`)
        let next: string
        if (fenceRegex.test(existing)) {
          next = existing.replace(fenceRegex, block)
        } else if (existing.trim().length === 0) {
          next = block
        } else {
          next = `${existing.replace(/\s+$/, '')}\n\n${block}`
        }
        if (next === existing) return
        const tmp = `${filePath}.tmp`
        fs.writeFileSync(tmp, next)
        fs.renameSync(tmp, filePath)
      })
    } catch {
      // Best-effort. Lockfile contention, removed parent dir, etc. should not
      // crash the adapter.
    }
  }

  return {
    setEntries(next) {
      // Cheap shallow equality so identical re-runs don't churn writes.
      if (entriesEqual(entries, next)) return
      entries = [...next]
      scheduleWrite()
    },
    getEntries() {
      return [...entries]
    },
    flush() {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      writeNow()
    },
    dispose() {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
    }
  }
}

function buildBlock(entries: WorkspaceEntry[]): string {
  const lines: string[] = [FENCE_BEGIN, '## Workspaces', '']
  if (entries.length === 0) {
    lines.push('_(no Sovereign-managed workspaces yet)_')
  } else {
    for (const e of entries) {
      const parts = [`- \`${e.path}\``]
      if (e.description) parts.push(`— ${e.description}`)
      if (e.orgId) parts.push(`(org: ${e.orgId})`)
      lines.push(parts.join(' '))
    }
  }
  lines.push('', FENCE_END, '')
  return lines.join('\n')
}

function entriesEqual(a: WorkspaceEntry[], b: WorkspaceEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path) return false
    if ((a[i].description ?? '') !== (b[i].description ?? '')) return false
    if ((a[i].orgId ?? '') !== (b[i].orgId ?? '')) return false
  }
  return true
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
