import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createIssueCache } from './cache.js'
import type { Issue } from './types.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-cache-'))
}

const sampleIssues: Issue[] = [
  {
    id: '1',
    kind: 'issue',
    projectId: 'proj1',
    orgId: 'org1',
    remote: 'origin',
    provider: 'github',
    title: 'Bug',
    body: 'desc',
    state: 'open',
    labels: [],
    assignees: [],
    author: 'alice',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    commentCount: 0
  }
]

describe('IssueCache', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = tmpDir()
  })
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  describe('store and retrieve', () => {
    it('stores a value and retrieves it by key', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      const result = cache.getCached('org1', 'proj1')
      expect(result).toEqual(sampleIssues)
    })

    it('returns undefined for non-existent key', () => {
      const cache = createIssueCache(dataDir)
      expect(cache.getCached('org1', 'nonexistent')).toBeUndefined()
    })

    it('overwrites existing value', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      const updated = [{ ...sampleIssues[0], title: 'Updated' }]
      cache.setCached('org1', 'proj1', updated)
      expect(cache.getCached('org1', 'proj1')![0].title).toBe('Updated')
    })
  })

  describe('TTL expiry', () => {
    it('marks entry as stale after TTL expires', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      // With 0ms TTL, should be stale immediately
      expect(cache.isStale('org1', 'proj1', -1)).toBe(true)
    })

    it('returns non-stale for fresh entries', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      expect(cache.isStale('org1', 'proj1', 60000)).toBe(false)
    })

    it('uses configurable TTL (default 5 minutes)', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      // Default TTL is 5 min, freshly set should not be stale
      expect(cache.isStale('org1', 'proj1')).toBe(false)
    })
  })

  describe('staleness indicator', () => {
    it('isStale returns false for fresh entries', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      expect(cache.isStale('org1', 'proj1', 300000)).toBe(false)
    })

    it('isStale returns true for expired entries', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      expect(cache.isStale('org1', 'proj1', -1)).toBe(true)
    })
  })

  describe('clear', () => {
    it('removes all cached entries', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      cache.clear()
      expect(cache.getCached('org1', 'proj1')).toBeUndefined()
    })
  })

  describe('offline queue', () => {
    it('enqueues write operations to queue.jsonl', () => {
      const cache = createIssueCache(dataDir)
      cache.queueWrite({ type: 'create', orgId: 'org1', projectId: 'proj1', remote: 'origin', data: { title: 'Test' } })
      const queue = cache.getQueue()
      expect(queue).toHaveLength(1)
      expect(queue[0].type).toBe('create')
    })

    it('persists queue to disk', () => {
      const cache = createIssueCache(dataDir)
      cache.queueWrite({ type: 'create', orgId: 'org1', projectId: 'proj1', remote: 'origin', data: { title: 'Test' } })
      const queueFile = path.join(dataDir, 'issues', 'queue.jsonl')
      expect(fs.existsSync(queueFile)).toBe(true)
      const content = fs.readFileSync(queueFile, 'utf-8')
      expect(content.trim()).not.toBe('')
    })

    it('removeFromQueue removes specific entry', () => {
      const cache = createIssueCache(dataDir)
      cache.queueWrite({ type: 'create', orgId: 'org1', projectId: 'proj1', remote: 'origin', data: { title: 'A' } })
      cache.queueWrite({ type: 'create', orgId: 'org1', projectId: 'proj1', remote: 'origin', data: { title: 'B' } })
      const queue = cache.getQueue()
      expect(queue).toHaveLength(2)
      cache.removeFromQueue(queue[0].id)
      expect(cache.getQueue()).toHaveLength(1)
      expect(cache.getQueue()[0].data.title).toBe('B')
    })
  })

  describe('persistence', () => {
    it('persists cache as JSON files at {dataDir}/issues/{orgId}/{projectId}/', () => {
      const cache = createIssueCache(dataDir)
      cache.setCached('org1', 'proj1', sampleIssues)
      const file = path.join(dataDir, 'issues', 'org1', 'proj1', 'issues.json')
      expect(fs.existsSync(file)).toBe(true)
    })

    it('loads cached data on startup', () => {
      const cache1 = createIssueCache(dataDir)
      cache1.setCached('org1', 'proj1', sampleIssues)

      // Create new cache instance pointing at same dir
      const cache2 = createIssueCache(dataDir)
      const result = cache2.getCached('org1', 'proj1')
      expect(result).toEqual(sampleIssues)
    })
  })
})
