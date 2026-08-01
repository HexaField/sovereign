// Single-instance lockfile (R17).
//
// Extracted from index.ts so the acquire/release policy can be tested. The
// entry module runs its side effects on import, which makes the policy
// untestable in place — and this policy caused a 58-hour, 41,901-restart loop
// on 2026-08-01, so it earns direct coverage.

import fs from 'node:fs'

export interface LockRecord {
  pid: number
  startedAt: number
  host: string
}

export interface LockfileOptions {
  lockPath: string
  host: string
  /** Defaults to `process.pid`. Injected for tests. */
  pid?: number
  /** Liveness probe. Defaults to `process.kill(pid, 0)`. Injected for tests. */
  isAlive?(pid: number): boolean
  /** Identity probe. Defaults to {@link pidLooksLikeSovereign}. Injected for tests. */
  isSovereign?(pid: number): boolean
  /** Defaults to `Date.now()`. Injected for tests. */
  now?(): number
}

/** What {@link Lockfile.acquire} decided, so the caller can log and act. */
export type AcquireResult =
  | { outcome: 'acquired'; reason: 'no-lock' | 'stale-pid' | 'holder-not-sovereign'; previous?: LockRecord }
  | { outcome: 'refused'; reason: 'holder-alive'; previous: LockRecord }

/** What {@link Lockfile.checkOwnership} found on a single poll. */
export type OwnershipState = 'held' | 'missing' | 'stolen'

export interface Lockfile {
  acquire(): AcquireResult
  release(): void
  read(): LockRecord | null
  /**
   * Compare the on-disk lock against this process. Losing the lock while still
   * running means the single-instance guard has been disarmed — the failure the
   * caller must surface rather than swallow.
   */
  checkOwnership(): OwnershipState
}

/**
 * Is `pid` actually a Sovereign server, or just some unrelated process that
 * happens to have inherited a recycled pid? A bare `process.kill(pid, 0)`
 * probe cannot tell the difference, and a false positive is expensive: the new
 * instance refuses to boot, systemd restarts it, and the cycle repeats
 * indefinitely (observed: 41,901 restarts over 58h). Reading the cmdline makes
 * the check specific. Unreadable /proc (permissions, non-Linux) falls back to
 * "assume it is ours" — refusing to boot is the safe default when unsure.
 */
export function pidLooksLikeSovereign(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ')
    if (!cmdline.trim()) return true
    return cmdline.includes('server/dist/index.js') || cmdline.includes('packages/server')
  } catch {
    return true
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0) // probe — throws ESRCH when not running
    return true
  } catch {
    return false
  }
}

export function createLockfile(opts: LockfileOptions): Lockfile {
  const { lockPath, host } = opts
  const pid = opts.pid ?? process.pid
  const isAlive = opts.isAlive ?? defaultIsAlive
  const isSovereign = opts.isSovereign ?? pidLooksLikeSovereign
  const now = opts.now ?? Date.now

  function read(): LockRecord | null {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockRecord
    } catch {
      return null
    }
  }

  function write(): void {
    fs.writeFileSync(lockPath, JSON.stringify({ pid, startedAt: now(), host }))
  }

  return {
    read,

    acquire(): AcquireResult {
      const prev = read()
      if (!prev?.pid || prev.pid === pid) {
        write()
        return { outcome: 'acquired', reason: 'no-lock', previous: prev ?? undefined }
      }
      if (!isAlive(prev.pid)) {
        write()
        return { outcome: 'acquired', reason: 'stale-pid', previous: prev }
      }
      if (!isSovereign(prev.pid)) {
        write()
        return { outcome: 'acquired', reason: 'holder-not-sovereign', previous: prev }
      }
      return { outcome: 'refused', reason: 'holder-alive', previous: prev }
    },

    checkOwnership(): OwnershipState {
      const cur = read()
      if (!cur) return 'missing'
      return cur.pid === pid ? 'held' : 'stolen'
    },

    // Only unlink a lock we still own. A losing instance that exits must not
    // delete the winner's lock — that would silently disable the guard for the
    // process that is actually running.
    release(): void {
      const prev = read()
      if (prev?.pid === pid) {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* already gone — fine */
        }
      }
    }
  }
}
