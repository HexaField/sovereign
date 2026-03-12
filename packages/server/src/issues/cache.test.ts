import { describe, it } from 'vitest'

describe('IssueCache', () => {
  describe('store and retrieve', () => {
    it.todo('stores a value and retrieves it by key')
    it.todo('returns undefined for non-existent key')
    it.todo('overwrites existing value')
  })

  describe('TTL expiry', () => {
    it.todo('marks entry as stale after TTL expires')
    it.todo('returns non-stale for fresh entries')
    it.todo('uses configurable TTL (default 5 minutes)')
  })

  describe('staleness indicator', () => {
    it.todo('isStale returns false for fresh entries')
    it.todo('isStale returns true for expired entries')
  })

  describe('clear', () => {
    it.todo('removes all cached entries')
  })

  describe('offline queue', () => {
    it.todo('enqueues write operations to queue.jsonl')
    it.todo('persists queue to disk')
    it.todo('flushQueue replays queued operations')
    it.todo('flushQueue returns replayed and failed counts')
    it.todo('flushQueue clears queue after successful replay')
    it.todo('flushQueue retains failed operations')
  })

  describe('persistence', () => {
    it.todo('persists cache as JSON files at {dataDir}/issues/{orgId}/{projectId}/')
    it.todo('loads cached data on startup')
  })
})
