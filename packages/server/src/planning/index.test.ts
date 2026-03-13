import { describe, it } from 'vitest'

describe('Dependency Index', () => {
  describe('1.4 Dependency Index (Cache)', () => {
    it.todo('MUST maintain local dependency index at {dataDir}/planning/{orgId}/deps.json')
    it.todo('MUST contain parsed dependency edges in the index')
    it.todo('MUST contain last-synced timestamp per project in the index')
    it.todo('MUST contain hash of source issue body for change detection')
    it.todo('MUST rebuild index from provider data on explicit sync')
    it.todo('MUST rebuild index when issue cache is refreshed')
    it.todo('MUST NOT be the source of truth — derived cache only')
    it.todo('MUST rebuild from scratch if deleted')
    it.todo('MUST write atomically (write temp file → rename)')
  })
})
