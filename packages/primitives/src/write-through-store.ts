// Directory-keyed write-through store. Each key maps to a separate file under
// the configured directory so independent keys don't compete for the same
// write lock and so per-key state is trivially inspectable on disk.
//
// Filenames are URL-encoded so canonical session keys with colons (e.g.
// `agent:main:thread:foo`) round-trip cleanly across filesystems.

import fs from 'node:fs'
import path from 'node:path'
import { createWriteThroughFile, type WriteThroughFile } from './write-through-file.js'

export interface WriteThroughStoreOptions {
  /** Directory holding the per-key files. Created if missing. */
  dirPath: string
  /** Schema version applied to every file. */
  version: number
  /** Per-key debounce window. Defaults to 250ms. */
  debounceMs?: number
  /** Label root used in log lines. Defaults to the directory basename. */
  label?: string
}

export interface WriteThroughStore<T> {
  /** Current value for `key`, or undefined if no file exists. */
  get(key: string): T | undefined
  /** Schedule a debounced write for `key`. */
  set(key: string, value: T): void
  /** Write `value` for `key` synchronously. */
  setSync(key: string, value: T): void
  /** Remove the per-key file from disk and drop the in-memory entry. */
  remove(key: string): void
  /** All current entries (loaded from disk on construction). */
  entries(): Array<{ key: string; value: T }>
  /** Synchronously flush every per-key pending write. */
  flush(): void
}

export function createWriteThroughStore<T>(opts: WriteThroughStoreOptions): WriteThroughStore<T> {
  const { dirPath, version } = opts
  const debounceMs = opts.debounceMs ?? 250
  const label = opts.label ?? path.basename(dirPath)
  fs.mkdirSync(dirPath, { recursive: true })

  const files = new Map<string, WriteThroughFile<T>>()

  // Eagerly hydrate on construction so `entries()` is correct without I/O.
  try {
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.json')) continue
      if (file.endsWith('.tmp')) continue
      const key = decodeURIComponent(file.slice(0, -'.json'.length))
      ensureFile(key)
    }
  } catch {
    /* empty directory or missing — fine */
  }

  function pathFor(key: string): string {
    return path.join(dirPath, `${encodeURIComponent(key)}.json`)
  }

  function ensureFile(key: string): WriteThroughFile<T> {
    let f = files.get(key)
    if (f) return f
    f = createWriteThroughFile<T>({
      filePath: pathFor(key),
      version,
      defaultValue: undefined as unknown as T,
      debounceMs,
      label: `${label}/${key}`
    })
    files.set(key, f)
    return f
  }

  return {
    get(key: string): T | undefined {
      const f = files.get(key)
      if (!f) return undefined
      const v = f.read()
      return v === undefined ? undefined : v
    },
    set(key: string, value: T) {
      ensureFile(key).write(value)
    },
    setSync(key: string, value: T) {
      ensureFile(key).writeSync(value)
    },
    remove(key: string) {
      const f = files.get(key)
      if (!f) return
      f.remove()
      files.delete(key)
    },
    entries() {
      const out: Array<{ key: string; value: T }> = []
      for (const [key, f] of files) {
        const v = f.read()
        if (v !== undefined) out.push({ key, value: v })
      }
      return out
    },
    flush() {
      for (const f of files.values()) f.flush()
    }
  }
}
