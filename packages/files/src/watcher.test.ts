import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createFileWatcher } from './watcher.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-watcher-test-'))
}

describe('FileWatcher', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    cleanups.forEach((fn) => fn())
    cleanups.length = 0
  })

  it('ignores changes inside data/ directory (prevents event log feedback loop)', async () => {
    const root = tmpDir()
    const bus = createEventBus(root)
    const events: Array<{ type: string; path: string }> = []

    bus.on('file.*', (e) => {
      const p = (e.payload as any)?.path ?? ''
      events.push({ type: e.type, path: p })
    })

    const watcher = createFileWatcher(bus, root)
    watcher.start()
    cleanups.push(() => watcher.stop())

    // Write to data/events/ — should be ignored
    const eventsDir = path.join(root, 'data', 'events')
    fs.mkdirSync(eventsDir, { recursive: true })
    fs.writeFileSync(path.join(eventsDir, '2026-06-16.jsonl'), '{"test":true}\n')

    // Write to a non-data file — should emit
    fs.writeFileSync(path.join(root, 'test-file.md'), 'hello')

    // Wait for debounce (100ms) + buffer
    await new Promise((r) => setTimeout(r, 300))

    const dataPaths = events.filter((e) => e.path.startsWith('data/') || e.path.startsWith('data\\'))
    const normalPaths = events.filter((e) => e.path === 'test-file.md')

    expect(dataPaths).toHaveLength(0)
    expect(normalPaths.length).toBeGreaterThan(0)
  })

  it('ignores log files in data/ subdirectories', async () => {
    const root = tmpDir()
    const bus = createEventBus(root)
    const events: Array<{ type: string; path: string }> = []

    bus.on('file.*', (e) => {
      const p = (e.payload as any)?.path ?? ''
      events.push({ type: e.type, path: p })
    })

    const watcher = createFileWatcher(bus, root)
    watcher.start()
    cleanups.push(() => watcher.stop())

    const logsDir = path.join(root, 'data', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    fs.writeFileSync(path.join(logsDir, 'sovereign.stdout.log'), 'log line\n')

    await new Promise((r) => setTimeout(r, 300))

    const dataPaths = events.filter((e) => e.path.startsWith('data/') || e.path.startsWith('data\\'))
    expect(dataPaths).toHaveLength(0)
  })
})
