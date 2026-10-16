// Repo cache — one JSON file per repo under <dataDir>/forge/cache/. Forge
// data is regenerable, so it lives here and not in AD4M. Writes go to a temp
// file that is renamed over the old one, so a crash leaves either the old or
// the new snapshot, never half of one.

import fs from 'node:fs'
import path from 'node:path'
import type { RepoCache } from './types.js'

export function emptyCache(forge: RepoCache['forge'], host: string, repo: string): RepoCache {
  return {
    version: 1,
    forge,
    host,
    repo,
    changes: {},
    issues: {},
    branches: {},
    backfill: {
      changes: { done: false, pages: 0, items: 0 },
      issues: { done: false, pages: 0, items: 0 }
    },
    stale: []
  }
}

export function cacheFileName(forge: string, host: string, repo: string): string {
  return `${forge}_${host}_${repo}`.replace(/[^\w.-]+/g, '_') + '.json'
}

/** Write JSON atomically: temp file, fsync, rename. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(data))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

export interface RepoCacheStore {
  dir: string
  load(forge: RepoCache['forge'], host: string, repo: string): RepoCache
  save(cache: RepoCache): void
}

export function createRepoCacheStore(dataDir: string): RepoCacheStore {
  const dir = path.join(dataDir, 'forge', 'cache')
  const fileOf = (forge: string, host: string, repo: string) => path.join(dir, cacheFileName(forge, host, repo))
  return {
    dir,
    load(forge, host, repo) {
      const c = readJson<RepoCache>(fileOf(forge, host, repo))
      if (!c || c.version !== 1 || c.repo !== repo) return emptyCache(forge, host, repo)
      const base = emptyCache(forge, host, repo)
      return {
        ...base,
        ...c,
        backfill: {
          changes: { ...base.backfill.changes, ...c.backfill?.changes },
          issues: { ...base.backfill.issues, ...c.backfill?.issues }
        },
        stale: c.stale ?? []
      }
    },
    save(cache) {
      writeJsonAtomic(fileOf(cache.forge, cache.host, cache.repo), cache)
    }
  }
}
