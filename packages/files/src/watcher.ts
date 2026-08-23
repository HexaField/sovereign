// File watcher — watches for filesystem changes and emits bus events.
// Uses chokidar so that IGNORE_PATTERNS are applied at watch-registration
// time, not just at event-filter time. The old fs.watch({ recursive: true })
// approach registered an inotify watch on every subdirectory in the tree
// (including .git/objects, node_modules, dist, …) and exhausted the kernel's
// inotify limit (fs.inotify.max_user_watches) with 7+ large org roots.

import path from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { FSWatcher } from 'chokidar'
import type { EventBus } from '@sovereign/core'

const IGNORE_SEGMENTS = new Set([
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
  '.venv',
  '.venv-gpu',
  'venv',
  'results', // SNN experiment result JSON files
  'target', // Rust build artefacts
  '.codegraph', // CodeGraph SQLite DB (has its own watcher)
  '.mypy_cache',
  '.pytest_cache',
  'coverage'
])

/**
 * Returns true if ANY segment of `filePath` matches an ignored directory name.
 * Used as chokidar's `ignored` predicate — applied before a watch gets registered,
 * so excluded directories never consume inotify descriptors.
 */
function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep)
  return parts.some((p) => IGNORE_SEGMENTS.has(p))
}

export interface FileWatcher {
  start(): void
  stop(): void
  watching(): boolean
}

export function createFileWatcher(bus: EventBus, rootPath: string): FileWatcher {
  return createMultiRootFileWatcher(bus, [rootPath])
}

/**
 * Watch multiple root directories for filesystem changes.
 * Each root shares a single chokidar instance; events carry the
 * originating root so subscribers can resolve relative paths.
 */
export function createMultiRootFileWatcher(bus: EventBus, rootPaths: string[]): FileWatcher {
  let watcher: FSWatcher | null = null
  let isWatching = false

  const now = () => new Date().toISOString()

  function rootFor(filePath: string): string {
    return rootPaths.find((r) => filePath.startsWith(r + path.sep) || filePath === r) ?? rootPaths[0]
  }

  function emitChange(eventType: 'file.changed' | 'file.deleted', fullPath: string) {
    const root = rootFor(fullPath)
    const relativePath = path.relative(root, fullPath)
    bus.emit({
      type: eventType,
      timestamp: now(),
      source: 'files',
      payload: { path: relativePath, fullPath, root }
    })
  }

  return {
    start() {
      if (isWatching || rootPaths.length === 0) return

      watcher = chokidarWatch(rootPaths, {
        // Apply ignore patterns at watch-registration time — chokidar will not
        // descend into (or add inotify watches for) any path that matches.
        ignored: shouldIgnore,
        persistent: true,
        ignoreInitial: true, // don't flood the bus for existing files on start
        followSymlinks: false,
        ignorePermissionErrors: true,
        // Debounce rapid file writes (e.g. editor save sequences) into a single event.
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
      })

      watcher.on('add', (p) => emitChange('file.changed', p))
      watcher.on('change', (p) => emitChange('file.changed', p))
      watcher.on('unlink', (p) => emitChange('file.deleted', p))
      watcher.on('unlinkDir', (p) => emitChange('file.deleted', p))
      watcher.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[file-watcher] Error:`, msg)
      })

      isWatching = true
    },

    stop() {
      if (watcher) {
        watcher.close()
        watcher = null
      }
      isWatching = false
    },

    watching() {
      return isWatching
    }
  }
}
