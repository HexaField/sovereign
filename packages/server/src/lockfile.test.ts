// Regression coverage for the single-instance lockfile.
//
// Incident 2026-08-01: a Sovereign instance survived its own SIGINT (no
// process.exit in the signal handler), was re-parented to init, and kept
// holding the lock. Every replacement start refused to boot, systemd retried
// on RestartSec forever — 41,901 restarts over 58 hours, silently. Two
// properties below are what stop that recurring:
//   1. a live holder that is NOT a Sovereign process must not block a boot
//      (pid recycling must never be able to wedge the service), and
//   2. release() must only unlink a lock we still own (a losing instance must
//      not disarm the guard for the winner).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLockfile, type LockRecord } from './lockfile.js'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-lock-'))
  lockPath = path.join(dir, '.sovereign.lock')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function seed(record: LockRecord): void {
  fs.writeFileSync(lockPath, JSON.stringify(record))
}

function read(): LockRecord | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as LockRecord
  } catch {
    return null
  }
}

const base = { host: '127.0.0.1', now: () => 1_000 }

describe('acquire', () => {
  it('writes a fresh lock when none exists', () => {
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    expect(lock.acquire()).toMatchObject({ outcome: 'acquired', reason: 'no-lock' })
    expect(read()).toEqual({ pid: 42, startedAt: 1_000, host: '127.0.0.1' })
  })

  it('claims a lock whose holder is gone', () => {
    seed({ pid: 7, startedAt: 1, host: '127.0.0.1' })
    const lock = createLockfile({ ...base, lockPath, pid: 42, isAlive: () => false })
    expect(lock.acquire()).toMatchObject({ outcome: 'acquired', reason: 'stale-pid' })
    expect(read()?.pid).toBe(42)
  })

  it('refuses to boot when a live Sovereign holds the lock', () => {
    seed({ pid: 7, startedAt: 1, host: '127.0.0.1' })
    const lock = createLockfile({ ...base, lockPath, pid: 42, isAlive: () => true, isSovereign: () => true })
    expect(lock.acquire()).toMatchObject({ outcome: 'refused', reason: 'holder-alive' })
    expect(read()?.pid).toBe(7) // holder's lock left untouched
  })

  it('claims the lock when the live holder is an unrelated process (pid recycling)', () => {
    // The wedge case. Without the identity probe this returns `refused`, the
    // service can never start, and systemd loops forever.
    seed({ pid: 7, startedAt: 1, host: '127.0.0.1' })
    const lock = createLockfile({ ...base, lockPath, pid: 42, isAlive: () => true, isSovereign: () => false })
    expect(lock.acquire()).toMatchObject({ outcome: 'acquired', reason: 'holder-not-sovereign' })
    expect(read()?.pid).toBe(42)
  })

  it('rewrites its own lock rather than refusing itself', () => {
    seed({ pid: 42, startedAt: 1, host: '127.0.0.1' })
    const lock = createLockfile({ ...base, lockPath, pid: 42, isAlive: () => true, isSovereign: () => true })
    expect(lock.acquire()).toMatchObject({ outcome: 'acquired' })
    expect(read()?.startedAt).toBe(1_000)
  })

  it('treats a corrupt lock as absent', () => {
    fs.writeFileSync(lockPath, 'not json {{{')
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    expect(lock.acquire()).toMatchObject({ outcome: 'acquired', reason: 'no-lock' })
    expect(read()?.pid).toBe(42)
  })
})

describe('checkOwnership', () => {
  it('reports held while we own the lock', () => {
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    lock.acquire()
    expect(lock.checkOwnership()).toBe('held')
  })

  it('reports missing when the lock is deleted underneath us', () => {
    // The 2026-08-01 shape: a second unit ran `ExecStartPre=/bin/rm -f` on the
    // lock before every start attempt, disarming the guard with no signal.
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    lock.acquire()
    fs.unlinkSync(lockPath)
    expect(lock.checkOwnership()).toBe('missing')
  })

  it('reports stolen when another pid has taken the lock', () => {
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    lock.acquire()
    seed({ pid: 99, startedAt: 2, host: '127.0.0.1' })
    expect(lock.checkOwnership()).toBe('stolen')
  })

  it('recovers to held after re-acquiring a vanished lock', () => {
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    lock.acquire()
    fs.unlinkSync(lockPath)
    expect(lock.checkOwnership()).toBe('missing')
    lock.acquire()
    expect(lock.checkOwnership()).toBe('held')
  })
})

describe('release', () => {
  it('removes a lock we own', () => {
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    lock.acquire()
    lock.release()
    expect(fs.existsSync(lockPath)).toBe(false)
  })

  it("leaves another instance's lock alone", () => {
    // A refused instance calls release() on its way out via process.on('exit').
    // Deleting here would disarm the guard for the instance actually running.
    seed({ pid: 7, startedAt: 1, host: '127.0.0.1' })
    const loser = createLockfile({ ...base, lockPath, pid: 42, isAlive: () => true, isSovereign: () => true })
    expect(loser.acquire().outcome).toBe('refused')
    loser.release()
    expect(read()?.pid).toBe(7)
  })

  it('is a no-op when the lock has already vanished', () => {
    const lock = createLockfile({ ...base, lockPath, pid: 42 })
    lock.acquire()
    fs.unlinkSync(lockPath)
    expect(() => lock.release()).not.toThrow()
  })
})
