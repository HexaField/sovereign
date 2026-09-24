/**
 * File watcher tests — real directories, real kernel watches.
 *
 * The regression guard is the inotify count: one watch per directory and none
 * per file. A watch per file (chokidar) exhausted the per-user limit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMultiRootFileWatcher, isIgnoredName, type FileWatcher, type FileWatcherOptions } from './watcher.js'

interface Emitted {
  type: string
  payload: { path: string; fullPath: string; root: string }
}

const SETTLE = 40
const linuxIt = process.platform === 'linux' ? it : it.skip
const cleanups: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  vi.restoreAllMocks()
})

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-watch-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(file: string, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

async function startWatcher(roots: string[], opts: FileWatcherOptions = {}) {
  const events: Emitted[] = []
  const watcher: FileWatcher = createMultiRootFileWatcher({ emit: (e: Emitted) => events.push(e) } as any, roots, {
    settleMs: SETTLE,
    ...opts
  })
  cleanups.unshift(() => watcher.stop())
  watcher.start()
  await watcher.ready()
  return { watcher, events }
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting for watcher event')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const quiet = () => new Promise((r) => setTimeout(r, SETTLE * 6))
const saw = (events: Emitted[], type: string, fullPath: string) =>
  events.some((e) => e.type === type && e.payload.fullPath === fullPath)

/** inotify watches this process holds (Linux). */
function inotifyWatches(): number {
  let n = 0
  for (const fd of fs.readdirSync('/proc/self/fdinfo')) {
    try {
      n += fs
        .readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('inotify wd:')).length
    } catch {
      /* fd closed while reading */
    }
  }
  return n
}

describe('isIgnoredName', () => {
  it('ignores build output, dependencies, virtualenvs and training data', () => {
    for (const name of [
      '.git',
      'node_modules',
      'dist',
      '.venv',
      '.venv-gpu',
      '.venv-3.14-backup',
      'training_data',
      'training_output'
    ]) {
      expect(isIgnoredName(name), name).toBe(true)
    }
    for (const name of ['src', 'venv-notes.md', 'datasets', 'README.md']) {
      expect(isIgnoredName(name), name).toBe(false)
    }
  })
})

describe('createMultiRootFileWatcher — per-directory mode', () => {
  linuxIt('holds one kernel watch per directory and none per file', async () => {
    const root = tmpRoot()
    for (let i = 0; i < 30; i++) write(path.join(root, i % 2 ? 'a/deep' : 'b', `f${i}.txt`))
    write(path.join(root, 'node_modules/pkg/index.js'))
    write(path.join(root, '.venv-gpu/lib/site.py'))
    const before = inotifyWatches()

    const { watcher } = await startWatcher([root], { mode: 'per-directory' })

    // root, a, a/deep, b — the ignored trees and the 30 files add nothing.
    expect(watcher.watchedDirectoryCount()).toBe(4)
    expect(inotifyWatches() - before).toBe(4)
    watcher.stop()
    expect(inotifyWatches()).toBe(before)
  })

  it('reports new, modified and deleted files with their root', async () => {
    const root = tmpRoot()
    const old = path.join(root, 'a/old.txt')
    write(old)
    const { events } = await startWatcher([root], { mode: 'per-directory' })

    const created = path.join(root, 'a/new.txt')
    write(created)
    await waitFor(() => saw(events, 'file.changed', created))
    expect(events.find((e) => e.payload.fullPath === created)?.payload).toEqual({
      path: path.join('a', 'new.txt'),
      fullPath: created,
      root
    })

    fs.appendFileSync(old, 'more')
    await waitFor(() => saw(events, 'file.changed', old))
    fs.rmSync(old)
    await waitFor(() => saw(events, 'file.deleted', old))
  })

  it('stays silent about a file created and removed within the settle window', async () => {
    const root = tmpRoot()
    const { events } = await startWatcher([root], { mode: 'per-directory' })
    const tmp = path.join(root, '.save.tmp')
    write(tmp)
    fs.rmSync(tmp)
    await quiet()
    expect(events.filter((e) => e.payload.fullPath === tmp)).toEqual([])
  })

  it('watches a new directory and reports files created inside it', async () => {
    const root = tmpRoot()
    const { watcher, events } = await startWatcher([root], { mode: 'per-directory' })
    const dir = path.join(root, 'fresh')
    fs.mkdirSync(dir)
    await waitFor(() => saw(events, 'file.changed', dir))
    expect(watcher.watchedDirectoryCount()).toBe(2)

    const inner = path.join(dir, 'inner.txt')
    write(inner)
    await waitFor(() => saw(events, 'file.changed', inner))
  })

  it('reports a deleted directory and stops watching everything beneath it', async () => {
    const root = tmpRoot()
    write(path.join(root, 'gone/sub/f.txt'))
    const { watcher, events } = await startWatcher([root], { mode: 'per-directory' })
    expect(watcher.watchedDirectoryCount()).toBe(3)

    const gone = path.join(root, 'gone')
    fs.rmSync(gone, { recursive: true })
    await waitFor(() => saw(events, 'file.deleted', gone))
    expect(watcher.watchedDirectoryCount()).toBe(1)
  })

  it('never watches or reports ignored names, even ones created later', async () => {
    const root = tmpRoot()
    const { watcher, events } = await startWatcher([root], { mode: 'per-directory' })
    write(path.join(root, 'node_modules/pkg/index.js'))
    write(path.join(root, 'training_data/sample.bin'))
    write(path.join(root, '.venv-3.14-backup/lib/x.py'))
    await quiet()
    expect(events).toEqual([])
    expect(watcher.watchedDirectoryCount()).toBe(1)
  })

  it('routes events to their own root', async () => {
    const [r1, r2] = [tmpRoot(), tmpRoot()]
    const { events } = await startWatcher([r1, r2], { mode: 'per-directory' })
    const f2 = path.join(r2, 'two.txt')
    write(f2)
    await waitFor(() => saw(events, 'file.changed', f2))
    expect(events.find((e) => e.payload.fullPath === f2)?.payload.root).toBe(r2)
  })

  it('starts once, stops cleanly, and ignores an empty root list', async () => {
    const root = tmpRoot()
    const { watcher, events } = await startWatcher([root], { mode: 'per-directory' })
    watcher.start()
    expect(watcher.watchedDirectoryCount()).toBe(1)

    watcher.stop()
    expect(watcher.watching()).toBe(false)
    expect(watcher.watchedDirectoryCount()).toBe(0)
    write(path.join(root, 'after-stop.txt'))
    await quiet()
    expect(events).toEqual([])

    const empty = createMultiRootFileWatcher({ emit: vi.fn() } as any, [])
    empty.start()
    expect(empty.watching()).toBe(false)
  })

  it('logs the watch limit once, not once per directory', async () => {
    const root = tmpRoot()
    for (const d of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, d))
    const realWatch = fs.watch
    vi.spyOn(fs, 'watch').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) !== root)
        throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' })
      return (realWatch as (...a: unknown[]) => fs.FSWatcher)(p, ...rest)
    }) as typeof fs.watch)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { watcher } = await startWatcher([root], { mode: 'per-directory' })

    expect(watcher.watchedDirectoryCount()).toBe(1)
    expect(errors).toHaveBeenCalledTimes(2)
    expect(String(errors.mock.calls[0][0])).toContain('max_user_watches')
    expect(String(errors.mock.calls[1][0])).toContain('3 directories left unwatched')
  })
})

describe('createMultiRootFileWatcher — recursive mode', () => {
  it('reports changes and drops ignored paths', async () => {
    const root = tmpRoot()
    fs.mkdirSync(path.join(root, 'a'))
    fs.mkdirSync(path.join(root, 'node_modules'))
    const { events } = await startWatcher([root], { mode: 'recursive' })

    const file = path.join(root, 'a/x.txt')
    write(file)
    await waitFor(() => saw(events, 'file.changed', file))
    write(path.join(root, 'node_modules/q.js'))
    await quiet()
    expect(events.some((e) => e.payload.fullPath.includes('node_modules'))).toBe(false)
  })
})
