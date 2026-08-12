// File watcher — watches for filesystem changes and emits bus events

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'

const IGNORE_PATTERNS = [
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
  '.cache'
]

function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep)
  return parts.some((p) => IGNORE_PATTERNS.includes(p))
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
 * Each root gets its own `fs.watch` instance; events carry the
 * originating root so subscribers can resolve relative paths.
 */
export function createMultiRootFileWatcher(bus: EventBus, rootPaths: string[]): FileWatcher {
  const watchers: fs.FSWatcher[] = []
  let isWatching = false

  // Debounce map: fullPath -> timeout
  const pending = new Map<string, NodeJS.Timeout>()
  const DEBOUNCE_MS = 100

  const now = () => new Date().toISOString()

  function emitChange(root: string, filePath: string) {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
    const relativePath = path.relative(root, fullPath)

    if (shouldIgnore(relativePath)) return

    let eventType: string
    try {
      fs.statSync(fullPath)
      eventType = 'file.changed'
    } catch {
      eventType = 'file.deleted'
    }

    bus.emit({
      type: eventType,
      timestamp: now(),
      source: 'files',
      payload: { path: relativePath, fullPath, root }
    })
  }

  function makeHandler(root: string) {
    return (_eventType: string, filename: string | null) => {
      if (!filename) return
      const key = path.join(root, filename)

      const existing = pending.get(key)
      if (existing) clearTimeout(existing)

      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key)
          emitChange(root, filename)
        }, DEBOUNCE_MS)
      )
    }
  }

  return {
    start() {
      if (isWatching) return
      for (const root of rootPaths) {
        try {
          const w = fs.watch(root, { recursive: true }, makeHandler(root))
          w.on('error', (err) => {
            console.error(`[file-watcher] Error on ${root}:`, err.message)
          })
          watchers.push(w)
        } catch (err: any) {
          console.error(`[file-watcher] Failed to start on ${root}:`, err.message)
        }
      }
      isWatching = watchers.length > 0
    },
    stop() {
      for (const w of watchers) w.close()
      watchers.length = 0
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      isWatching = false
    },
    watching() {
      return isWatching
    }
  }
}
