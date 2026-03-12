// Local JSON cache for reviews

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { Review } from './types.js'

export interface ReviewCache {
  getCached(orgId: string, projectId: string): Review[] | undefined
  setCached(orgId: string, projectId: string, reviews: Review[]): void
  isStale(orgId: string, projectId: string, ttlMs?: number): boolean
  clear(): void
}

const DEFAULT_TTL = 5 * 60 * 1000

export function createReviewCache(dataDir: string): ReviewCache {
  const timestamps = new Map<string, number>()

  function cacheDir(orgId: string, projectId: string): string {
    return path.join(dataDir, 'reviews', orgId, projectId)
  }

  function cacheFile(orgId: string, projectId: string): string {
    return path.join(cacheDir(orgId, projectId), 'reviews.json')
  }

  function cacheKey(orgId: string, projectId: string): string {
    return `${orgId}/${projectId}`
  }

  function atomicWrite(filePath: string, data: string): void {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex')
    fs.writeFileSync(tmp, data, 'utf-8')
    fs.renameSync(tmp, filePath)
  }

  function loadTimestamp(orgId: string, projectId: string): number | undefined {
    const key = cacheKey(orgId, projectId)
    if (timestamps.has(key)) return timestamps.get(key)
    const metaFile = path.join(cacheDir(orgId, projectId), 'meta.json')
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
      const ts = meta.updatedAt as number
      timestamps.set(key, ts)
      return ts
    } catch {
      return undefined
    }
  }

  return {
    getCached(orgId: string, projectId: string): Review[] | undefined {
      const file = cacheFile(orgId, projectId)
      try {
        const data = fs.readFileSync(file, 'utf-8')
        loadTimestamp(orgId, projectId)
        return JSON.parse(data) as Review[]
      } catch {
        return undefined
      }
    },

    setCached(orgId: string, projectId: string, reviews: Review[]): void {
      const file = cacheFile(orgId, projectId)
      atomicWrite(file, JSON.stringify(reviews, null, 2))
      const now = Date.now()
      timestamps.set(cacheKey(orgId, projectId), now)
      atomicWrite(path.join(cacheDir(orgId, projectId), 'meta.json'), JSON.stringify({ updatedAt: now }))
    },

    isStale(orgId: string, projectId: string, ttlMs: number = DEFAULT_TTL): boolean {
      const ts = loadTimestamp(orgId, projectId)
      if (ts === undefined) return true
      return Date.now() - ts > ttlMs
    },

    clear(): void {
      timestamps.clear()
      const reviewsDir = path.join(dataDir, 'reviews')
      try {
        fs.rmSync(reviewsDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }
}
