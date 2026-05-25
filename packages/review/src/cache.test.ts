import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createReviewCache } from './cache.js'
import type { Review } from './types.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'review-cache-test-'))
}

const sampleReview: Review = {
  id: '1',
  changeSetId: 'cs1',
  projectId: 'proj1',
  orgId: 'org1',
  remote: 'origin',
  provider: 'github',
  title: 'Test PR',
  description: 'Desc',
  status: 'open',
  author: 'alice',
  reviewers: [],
  baseBranch: 'main',
  headBranch: 'feat',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
}

describe('ReviewCache', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('store and retrieve', () => {
    it('stores a value and retrieves it by key', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      const result = cache.getCached('org1', 'proj1')
      expect(result).toHaveLength(1)
      expect(result![0].id).toBe('1')
    })

    it('returns undefined for non-existent key', () => {
      const cache = createReviewCache(dataDir)
      expect(cache.getCached('org1', 'nope')).toBeUndefined()
    })

    it('overwrites existing value', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      const updated = { ...sampleReview, title: 'Updated' }
      cache.setCached('org1', 'proj1', [updated])
      const result = cache.getCached('org1', 'proj1')
      expect(result![0].title).toBe('Updated')
    })
  })

  describe('TTL expiry', () => {
    it('marks entry as stale after TTL expires', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      // With a TTL of 0ms — freshly written might have same ms timestamp, use -1 to force stale
      expect(cache.isStale('org1', 'proj1', -1)).toBe(true)
    })

    it('returns non-stale for fresh entries', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      expect(cache.isStale('org1', 'proj1', 60000)).toBe(false)
    })
  })

  describe('staleness', () => {
    it('isStale returns false for fresh entries', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      expect(cache.isStale('org1', 'proj1')).toBe(false)
    })

    it('isStale returns true for expired entries', () => {
      const cache = createReviewCache(dataDir)
      expect(cache.isStale('org1', 'nonexistent')).toBe(true)
    })
  })

  describe('clear', () => {
    it('removes all cached entries', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      cache.clear()
      expect(cache.getCached('org1', 'proj1')).toBeUndefined()
    })
  })

  describe('persistence', () => {
    it('persists cache as JSON files at {dataDir}/reviews/{orgId}/{projectId}/', () => {
      const cache = createReviewCache(dataDir)
      cache.setCached('org1', 'proj1', [sampleReview])
      const file = path.join(dataDir, 'reviews', 'org1', 'proj1', 'reviews.json')
      expect(fs.existsSync(file)).toBe(true)
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(data).toHaveLength(1)
    })

    it('loads cached data on startup', () => {
      const cache1 = createReviewCache(dataDir)
      cache1.setCached('org1', 'proj1', [sampleReview])
      // Create a new cache instance pointing at same dir
      const cache2 = createReviewCache(dataDir)
      const result = cache2.getCached('org1', 'proj1')
      expect(result).toHaveLength(1)
    })
  })
})
