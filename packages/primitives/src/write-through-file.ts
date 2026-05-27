// Generic write-through file primitive. Used wherever a Sovereign module
// holds in-memory state that should survive a process restart with at most
// one debounce window of loss. The on-disk file is the canonical source of
// truth; the in-memory copy is a cache.
//
// Schema envelope: `{ version: number, data: T }`. Reads validate the version
// — a mismatch logs and returns the default (boot must never crash on a
// stale file).
//
// Writes use the standard temp-file + atomic rename pattern. Debounced
// writes coalesce rapid mutations; synchronous writes (and `flush()`) drain
// any pending debounce immediately.

import fs from 'node:fs'
import path from 'node:path'

export interface WriteThroughFileOptions<T> {
  /** Absolute file path. The parent directory is created if missing. */
  filePath: string
  /** Schema version. Files with a different version are treated as missing. */
  version: number
  /** Value returned when the file is absent or schema-incompatible. */
  defaultValue: T
  /** Debounce window for `write()`. Defaults to 250ms. Set 0 to write synchronously. */
  debounceMs?: number
  /** Optional label for log messages on schema mismatch. Defaults to the file basename. */
  label?: string
}

export interface WriteThroughFile<T> {
  /** Current in-memory value (synchronous; no disk read). */
  read(): T
  /** Schedule a debounced write of `value`. Last write wins within the debounce window. */
  write(value: T): void
  /** Write `value` to disk immediately, blocking until the rename completes. */
  writeSync(value: T): void
  /** Convenience: apply `fn` to the current value and schedule a write. */
  update(fn: (prev: T) => T): void
  /** Convenience: apply `fn` to the current value and write synchronously. */
  updateSync(fn: (prev: T) => T): void
  /** Synchronously flush any pending debounced write. Safe in shutdown handlers. */
  flush(): void
  /** Remove the file from disk and reset the in-memory copy to the default. */
  remove(): void
}

interface Envelope<T> {
  version: number
  data: T
}

const DEFAULT_DEBOUNCE_MS = 250

export function createWriteThroughFile<T>(opts: WriteThroughFileOptions<T>): WriteThroughFile<T> {
  const { filePath, version, defaultValue } = opts
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const label = opts.label ?? path.basename(filePath)
  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })

  let current: T = loadFromDisk()
  let writeTimer: ReturnType<typeof setTimeout> | null = null
  let pending: T | null = null

  function loadFromDisk(): T {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const env = JSON.parse(raw) as Envelope<T>
      if (env.version !== version) {
        console.warn(`[write-through:${label}] schema mismatch (got v${env.version}, want v${version}) — using default`)
        return defaultValue
      }
      return env.data
    } catch {
      return defaultValue
    }
  }

  function persist(value: T): void {
    try {
      fs.mkdirSync(dirPath, { recursive: true })
      const envelope: Envelope<T> = { version, data: value }
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(envelope))
      fs.renameSync(tmp, filePath)
    } catch (err: unknown) {
      // Best-effort: missing parent dir means we're tearing down. Don't throw
      // from a setTimeout callback or we get an unhandled exception.
      console.error(`[write-through:${label}] persist failed:`, (err as Error)?.message ?? err)
    }
  }

  function scheduleWrite(): void {
    if (debounceMs === 0) {
      if (pending !== null) {
        persist(pending)
        pending = null
      }
      return
    }
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      if (pending !== null) {
        persist(pending)
        pending = null
      }
    }, debounceMs)
  }

  return {
    read() {
      return current
    },
    write(value: T) {
      current = value
      pending = value
      scheduleWrite()
    },
    writeSync(value: T) {
      current = value
      pending = null
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      persist(value)
    },
    update(fn: (prev: T) => T) {
      current = fn(current)
      pending = current
      scheduleWrite()
    },
    updateSync(fn: (prev: T) => T) {
      current = fn(current)
      pending = null
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      persist(current)
    },
    flush() {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      if (pending !== null) {
        persist(pending)
        pending = null
      }
    },
    remove() {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      pending = null
      current = defaultValue
      try {
        fs.unlinkSync(filePath)
      } catch {
        /* already absent */
      }
    }
  }
}
