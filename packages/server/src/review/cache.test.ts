import { describe, it } from 'vitest'

describe('ReviewCache', () => {
  describe('store and retrieve', () => {
    it.todo('stores a value and retrieves it by key')
    it.todo('returns undefined for non-existent key')
    it.todo('overwrites existing value')
  })

  describe('TTL expiry', () => {
    it.todo('marks entry as stale after TTL expires')
    it.todo('returns non-stale for fresh entries')
  })

  describe('staleness', () => {
    it.todo('isStale returns false for fresh entries')
    it.todo('isStale returns true for expired entries')
  })

  describe('clear', () => {
    it.todo('removes all cached entries')
  })

  describe('persistence', () => {
    it.todo('persists cache as JSON files at {dataDir}/reviews/{orgId}/{projectId}/')
    it.todo('loads cached data on startup')
  })
})
