import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWriteThroughFile } from './write-through-file.js'
import { createWriteThroughStore } from './write-through-store.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtf-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('createWriteThroughFile', () => {
  it('returns the default when no file exists', () => {
    const f = createWriteThroughFile<{ x: number }>({
      filePath: path.join(tmpDir, 'a.json'),
      version: 1,
      defaultValue: { x: 0 }
    })
    expect(f.read()).toEqual({ x: 0 })
  })

  it('persists synchronously with writeSync', () => {
    const filePath = path.join(tmpDir, 'a.json')
    const f = createWriteThroughFile<{ x: number }>({
      filePath,
      version: 1,
      defaultValue: { x: 0 }
    })
    f.writeSync({ x: 42 })
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw).toEqual({ version: 1, data: { x: 42 } })
  })

  it('debounces and flushes', () => {
    const filePath = path.join(tmpDir, 'a.json')
    const f = createWriteThroughFile<number>({ filePath, version: 1, defaultValue: 0, debounceMs: 50 })
    f.write(1)
    f.write(2)
    f.write(3)
    // Before flush: file not yet written.
    expect(fs.existsSync(filePath)).toBe(false)
    f.flush()
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    expect(raw).toEqual({ version: 1, data: 3 })
  })

  it('returns default on schema-version mismatch', () => {
    const filePath = path.join(tmpDir, 'a.json')
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, data: { x: 7 } }))
    const f = createWriteThroughFile<{ x: number }>({
      filePath,
      version: 1,
      defaultValue: { x: 0 }
    })
    expect(f.read()).toEqual({ x: 0 })
  })

  it('round-trips on construction', () => {
    const filePath = path.join(tmpDir, 'a.json')
    const a = createWriteThroughFile<string>({ filePath, version: 1, defaultValue: '' })
    a.writeSync('hello')
    const b = createWriteThroughFile<string>({ filePath, version: 1, defaultValue: '' })
    expect(b.read()).toBe('hello')
  })

  it('remove() drops the file and resets to default', () => {
    const filePath = path.join(tmpDir, 'a.json')
    const f = createWriteThroughFile<{ x: number }>({ filePath, version: 1, defaultValue: { x: 0 } })
    f.writeSync({ x: 1 })
    expect(fs.existsSync(filePath)).toBe(true)
    f.remove()
    expect(fs.existsSync(filePath)).toBe(false)
    expect(f.read()).toEqual({ x: 0 })
  })
})

describe('createWriteThroughStore', () => {
  it('treats keys as separate files', () => {
    const dirPath = path.join(tmpDir, 'store')
    const s = createWriteThroughStore<{ n: number }>({ dirPath, version: 1, debounceMs: 0 })
    s.set('a:b', { n: 1 })
    s.set('c:d', { n: 2 })
    s.flush()
    expect(fs.existsSync(path.join(dirPath, encodeURIComponent('a:b') + '.json'))).toBe(true)
    expect(fs.existsSync(path.join(dirPath, encodeURIComponent('c:d') + '.json'))).toBe(true)
  })

  it('rehydrates entries from disk on construction', () => {
    const dirPath = path.join(tmpDir, 'store')
    const a = createWriteThroughStore<number>({ dirPath, version: 1, debounceMs: 0 })
    a.setSync('one', 1)
    a.setSync('two', 2)
    const b = createWriteThroughStore<number>({ dirPath, version: 1, debounceMs: 0 })
    const entries = b.entries().sort((x, y) => x.key.localeCompare(y.key))
    expect(entries).toEqual([
      { key: 'one', value: 1 },
      { key: 'two', value: 2 }
    ])
  })

  it('remove() deletes the per-key file', () => {
    const dirPath = path.join(tmpDir, 'store')
    const s = createWriteThroughStore<string>({ dirPath, version: 1, debounceMs: 0 })
    s.setSync('k', 'v')
    expect(fs.existsSync(path.join(dirPath, 'k.json'))).toBe(true)
    s.remove('k')
    expect(fs.existsSync(path.join(dirPath, 'k.json'))).toBe(false)
  })
})
