import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createMuteStore } from './mute-store.js'

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mute-store-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('MuteStore', () => {
  it('is initially empty', () => {
    const store = createMuteStore(tmpDir)
    expect(store.list()).toEqual([])
    expect(store.isMuted('t1')).toBe(false)
  })

  it('mute / unmute / list', () => {
    const store = createMuteStore(tmpDir)
    expect(store.mute('t1')).toBe(true)
    expect(store.mute('t1')).toBe(false) // already muted
    expect(store.isMuted('t1')).toBe(true)
    expect(store.list()).toEqual(['t1'])
    expect(store.unmute('t1')).toBe(true)
    expect(store.unmute('t1')).toBe(false)
    expect(store.isMuted('t1')).toBe(false)
  })

  it('persists across instances', () => {
    const store1 = createMuteStore(tmpDir)
    store1.mute('t1')
    store1.mute('t2')

    const store2 = createMuteStore(tmpDir)
    expect(store2.list()).toEqual(['t1', 't2'])
    expect(store2.isMuted('t1')).toBe(true)
  })

  it('writes a stable sorted format', () => {
    const store = createMuteStore(tmpDir)
    store.mute('z-thread')
    store.mute('a-thread')
    const file = path.join(tmpDir, 'thread-presence', 'mutes.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(parsed.mutedThreadIds).toEqual(['a-thread', 'z-thread'])
  })

  it('setAll replaces the full set', () => {
    const store = createMuteStore(tmpDir)
    store.mute('t1')
    store.setAll(['t2', 't3'])
    expect(store.list()).toEqual(['t2', 't3'])
    expect(store.isMuted('t1')).toBe(false)
  })

  it('tolerates a corrupt file', () => {
    const dir = path.join(tmpDir, 'thread-presence')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mutes.json'), '{ this is not json')
    const store = createMuteStore(tmpDir)
    expect(store.list()).toEqual([])
    // and a subsequent write recovers the file
    store.mute('t1')
    expect(store.list()).toEqual(['t1'])
  })

  it('ignores non-string entries on load', () => {
    const dir = path.join(tmpDir, 'thread-presence')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'mutes.json'), JSON.stringify({ mutedThreadIds: ['t1', null, 42, '', 't2'] }))
    const store = createMuteStore(tmpDir)
    expect(store.list()).toEqual(['t1', 't2'])
  })
})
