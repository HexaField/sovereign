// File watcher — watches for filesystem changes and emits bus events

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'

const IGNORE_PATTERNS = [
  '.git',
  'node_modules',
  '.DS_Store',
  '.sovereign-data',
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
  let watcher: fs.FSWatcher | null = null
  let isWatching = false

  // Debounce map: filePath -> timeout
  const pending = new Map<string, NodeJS.Timeout>()
  const DEBOUNCE_MS = 100

  const now = () => new Date().toISOString()

  function emitChange(filePath: string) {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath)
    const relativePath = path.relative(rootPath, fullPath)

    if (shouldIgnore(relativePath)) return

    // Determine event type
    let eventType: string
    try {
      fs.statSync(fullPath)
      // File exists — could be created or changed, we can't distinguish with fs.watch
      eventType = 'file.changed'
    } catch {
      eventType = 'file.deleted'
    }

    bus.emit({
      type: eventType,
      timestamp: now(),
      source: 'files',
      payload: { path: relativePath, fullPath }
    })
  }

  function handleEvent(_eventType: string, filename: string | null) {
    if (!filename) return
    const filePath = filename

    // Clear existing debounce timer
    const existing = pending.get(filePath)
    if (existing) clearTimeout(existing)

    pending.set(
      filePath,
      setTimeout(() => {
        pending.delete(filePath)
        emitChange(filePath)
      }, DEBOUNCE_MS)
    )
  }

  return {
    start() {
      if (isWatching) return
      try {
        watcher = fs.watch(rootPath, { recursive: true }, handleEvent)
        watcher.on('error', (err) => {
          console.error('[file-watcher] Error:', err.message)
        })
        isWatching = true
      } catch (err: any) {
        console.error('[file-watcher] Failed to start:', err.message)
      }
    },
    stop() {
      if (watcher) {
        watcher.close()
        watcher = null
      }
      for (const timer of pending.values()) clearTimeout(timer)
      pending.clear()
      isWatching = false
    },
    watching() {
      return isWatching
    }
  }
}
