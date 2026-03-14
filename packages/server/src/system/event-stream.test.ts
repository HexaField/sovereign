import { describe, it } from 'vitest'

describe('EventStream', () => {
  describe('ring buffer', () => {
    it.todo('stores entries up to capacity')
    it.todo('evicts oldest when full')
    it.todo('auto-incrementing id on entries')
    it.todo('capturedAt timestamp set on capture')
  })

  describe('query', () => {
    it.todo('with no filter returns all entries (newest first)')
    it.todo('filters by event type pattern (glob matching)')
    it.todo('filters by source module')
    it.todo('filters by time range (since/until)')
    it.todo('filters by entityId')
    it.todo('supports limit and offset')
    it.todo('combined filters (type + source + time)')
  })

  describe('stats', () => {
    it.todo('returns totalCaptured')
    it.todo('returns rate for last 1m, 5m, 1h')
    it.todo('returns byType counts for last 5 minutes')
    it.todo('returns bySource counts for last 5 minutes')
  })

  describe('subscriptions', () => {
    it.todo('subscribe receives new events matching filter')
    it.todo('subscribe with no filter receives all events')
    it.todo('unsubscribe stops delivery')
    it.todo('capture is async (does not block bus)')
  })
})
