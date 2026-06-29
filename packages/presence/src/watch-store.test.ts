import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createWatchStore } from './watch-store.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'presence-watch-'))
}

describe('WatchStore', () => {
  let dir: string
  beforeEach(() => {
    dir = tmpDir()
  })

  it('adds, lists, and removes entries', () => {
    const store = createWatchStore(dir)
    store.add('t1', 'because')
    store.add('t2')
    expect(store.has('t1')).toBe(true)
    expect(
      store
        .list()
        .map((e) => e.threadId)
        .sort()
    ).toEqual(['t1', 't2'])
    expect(store.remove('t1')).toBe(true)
    expect(store.has('t1')).toBe(false)
    expect(store.remove('t1')).toBe(false) // idempotent
  })

  it('persists across instances', () => {
    const a = createWatchStore(dir)
    a.add('t1', 'first')
    a.flush()
    const b = createWatchStore(dir)
    expect(b.has('t1')).toBe(true)
    expect(b.list()[0].reason).toBe('first')
  })

  it('updates reason on re-add', () => {
    const store = createWatchStore(dir)
    store.add('t1', 'first')
    const updated = store.add('t1', 'updated')
    expect(updated.reason).toBe('updated')
    expect(store.list()).toHaveLength(1)
  })

  it('preserves existing reason when re-add omits it', () => {
    const store = createWatchStore(dir)
    store.add('t1', 'kept')
    const reAdded = store.add('t1')
    expect(reAdded.reason).toBe('kept')
  })
})
