// File watcher — watches org roots for filesystem changes and emits bus events.
//
// Linux: one inotify watch per directory and none per file. A directory watch
// already reports every change to its entries, by name, so a watch per file
// adds only cost — and that was chokidar's cost: one watch per file, 228k for
// Sovereign's roots, past the kernel's per-user limit (65,536 by default),
// which starved every other watcher on the host. Ignored names are pruned
// before a watch is added.
//
// macOS / Windows: Node's native recursive watch (FSEvents /
// ReadDirectoryChangesW) costs nothing per directory; ignored paths are
// dropped at event time.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'

const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '.sovereign-data',
  'data',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  '.turbo',
  '.cache',
  'venv',
  'results', // SNN experiment result JSON files
  'target', // Rust build artefacts
  '.codegraph', // CodeGraph SQLite DB (has its own watcher)
  '.mypy_cache',
  '.pytest_cache',
  'coverage',
  'training_data', // ML datasets: hundreds of thousands of files
  'training_output'
])

/** True for a file or directory name the watcher never watches or reports. */
export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith('.venv') // .venv, .venv-gpu, .venv-3.14-backup, …
}

/** Quiet period before a changed path is reported; coalesces write bursts and atomic saves. */
const SETTLE_MS = 150

export interface FileWatcher {
  start(): void
  stop(): void
  watching(): boolean
  /** Resolves once the initial watches are in place. */
  ready(): Promise<void>
  /** Directories under watch in per-directory mode (0 in recursive mode). */
  watchedDirectoryCount(): number
}

export interface FileWatcherOptions {
  /** Default: 'per-directory' on Linux, 'recursive' elsewhere. */
  mode?: 'per-directory' | 'recursive'
  settleMs?: number
}

export function createFileWatcher(bus: EventBus, rootPath: string): FileWatcher {
  return createMultiRootFileWatcher(bus, [rootPath])
}

/**
 * Watch multiple root directories for filesystem changes. Events carry the
 * originating root so subscribers can resolve relative paths.
 */
export function createMultiRootFileWatcher(
  bus: EventBus,
  rootPaths: string[],
  opts: FileWatcherOptions = {}
): FileWatcher {
  const mode = opts.mode ?? (process.platform === 'linux' ? 'per-directory' : 'recursive')
  const settleMs = opts.settleMs ?? SETTLE_MS
  const roots = [...new Set(rootPaths.map((r) => path.resolve(r)))]
  // Per-directory mode: each watched directory, with the entry names it holds
  // and the inode its watch follows. Known entries let a vanished path be
  // reported only if it existed (a temp file created and removed within the
  // settle window stays silent); the inode reveals a directory replaced in place.
  const dirs = new Map<string, { watcher: fs.FSWatcher; entries: Set<string>; ino: number; dev: number }>()
  const rootWatchers: fs.FSWatcher[] = []
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  let generation = 0 // bumped by stop(): in-flight walks and settles see it and bail
  let isWatching = false
  let initial: Promise<void> = Promise.resolve()
  let unwatched = 0

  function rootFor(filePath: string): string {
    return roots.find((r) => filePath.startsWith(r + path.sep) || filePath === r) ?? roots[0]
  }

  function emit(type: 'file.changed' | 'file.deleted', fullPath: string) {
    const root = rootFor(fullPath)
    bus.emit({
      type,
      timestamp: new Date().toISOString(),
      source: 'files',
      payload: { path: path.relative(root, fullPath), fullPath, root }
    })
  }

  function watchError(err: unknown, dir: string) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOSPC' || code === 'EMFILE') {
      if (unwatched++ === 0) {
        console.error(
          `[file-watcher] watch limit reached at ${dir} — changes in unwatched directories go unreported. ` +
            `Raise fs.inotify.max_user_watches${limitHint()}.`
        )
      }
      return
    }
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return
    console.error(`[file-watcher] cannot watch ${dir}:`, err instanceof Error ? err.message : String(err))
  }

  /** Close the watches on `dir` and its subtree; return every entry path they held. */
  function forget(dir: string): string[] {
    const lost: string[] = []
    const prefix = dir + path.sep
    for (const [d, node] of dirs) {
      if (d !== dir && !d.startsWith(prefix)) continue
      node.watcher.close()
      dirs.delete(d)
      for (const name of node.entries) lost.push(path.join(d, name))
    }
    return lost
  }

  async function watchTree(dir: string, gen: number, stat?: fs.Stats): Promise<void> {
    if (gen !== generation || dirs.has(dir)) return
    // Take the inode before watching: if the path is replaced in between, the
    // next event for it shows a mismatch and re-watches rather than going deaf.
    const st = stat ?? (await fs.promises.lstat(dir).catch(() => null))
    if (!st?.isDirectory() || gen !== generation || dirs.has(dir)) return
    // Watch before listing, so an entry created in between still raises an event.
    let watcher: fs.FSWatcher
    try {
      watcher = fs.watch(dir, { persistent: true }, (_event, name) => {
        if (name && !isIgnoredName(name)) schedule(path.join(dir, name), gen)
      })
    } catch (err) {
      watchError(err, dir)
      return
    }
    watcher.on('error', () => forget(dir))
    const node = { watcher, entries: new Set<string>(), ino: st.ino, dev: st.dev }
    dirs.set(dir, node)
    let list: fs.Dirent[]
    try {
      list = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      forget(dir)
      return
    }
    if (gen !== generation) return
    for (const d of list) if (!isIgnoredName(d.name)) node.entries.add(d.name)
    await Promise.all(
      list.filter((d) => d.isDirectory() && !isIgnoredName(d.name)).map((d) => watchTree(path.join(dir, d.name), gen))
    )
  }

  function schedule(full: string, gen: number) {
    clearTimeout(pending.get(full))
    pending.set(
      full,
      setTimeout(() => {
        pending.delete(full)
        void settle(full, gen)
      }, settleMs)
    )
  }

  async function settle(full: string, gen: number) {
    const stat = await fs.promises.lstat(full).catch(() => null)
    if (gen !== generation) return
    if (mode === 'recursive') return emit(stat ? 'file.changed' : 'file.deleted', full)

    const parent = dirs.get(path.dirname(full))
    const name = path.basename(full)
    const watched = dirs.get(full)
    if (!stat) {
      // Gone. A watched directory takes its subtree with it: report every entry
      // it held, as a per-file watcher would, so an open file inside is released.
      const known = (parent?.entries.delete(name) ?? false) || watched !== undefined
      if (watched) for (const p of forget(full)) emit('file.deleted', p)
      if (known) emit('file.deleted', full)
      return
    }
    parent?.entries.add(name)
    if (!watched) {
      if (!stat.isDirectory()) return emit('file.changed', full)
      await watchTree(full, gen, stat)
      if (gen === generation) emit('file.changed', full)
      return
    }
    if (stat.isDirectory() && stat.ino === watched.ino && stat.dev === watched.dev) return // attribute change only
    // Replaced in place (rm + mkdir, rename over it, a git checkout): the old
    // watch follows the old inode. Re-watch the path, and report each entry the
    // old directory held as it now stands.
    const lost = forget(full)
    if (stat.isDirectory()) await watchTree(full, gen, stat)
    const present = await Promise.all(
      lost.map((p) =>
        fs.promises.lstat(p).then(
          () => true,
          () => false
        )
      )
    )
    if (gen !== generation) return
    lost.forEach((p, i) => emit(present[i] ? 'file.changed' : 'file.deleted', p))
    emit('file.changed', full)
  }

  function watchRecursive(root: string, gen: number) {
    try {
      const watcher = fs.watch(root, { persistent: true, recursive: true }, (_event, rel) => {
        if (!rel || rel.split(/[\\/]/).some(isIgnoredName)) return
        schedule(path.join(root, rel), gen)
      })
      watcher.on('error', (err) => console.error(`[file-watcher] ${root}:`, err.message))
      rootWatchers.push(watcher)
    } catch (err) {
      watchError(err, root)
    }
  }

  return {
    start() {
      if (isWatching || roots.length === 0) return
      isWatching = true
      unwatched = 0
      const gen = ++generation
      if (mode === 'recursive') {
        for (const root of roots) watchRecursive(root, gen)
        initial = Promise.resolve()
        return
      }
      initial = Promise.all(roots.map((root) => watchTree(root, gen))).then(() => {
        if (gen === generation && unwatched > 0) {
          console.error(
            `[file-watcher] ${unwatched} director${unwatched === 1 ? 'y' : 'ies'} left unwatched (watch limit), with everything beneath them`
          )
        }
      })
    },

    stop() {
      generation++
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      for (const node of dirs.values()) node.watcher.close()
      dirs.clear()
      for (const watcher of rootWatchers.splice(0)) watcher.close()
      isWatching = false
    },

    watching: () => isWatching,
    ready: () => initial,
    watchedDirectoryCount: () => dirs.size
  }
}

/** " (now N)" from the Linux inotify limit, or "" where it cannot be read. */
function limitHint(): string {
  try {
    return ` (now ${fs.readFileSync('/proc/sys/fs/inotify/max_user_watches', 'utf8').trim()})`
  } catch {
    return ''
  }
}
