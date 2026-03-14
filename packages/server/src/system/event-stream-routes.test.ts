import { describe, it } from 'vitest'

describe('Event Stream Routes', () => {
  describe('GET /api/system/events', () => {
    it.todo('returns recent events')
    it.todo('supports type filter query param')
    it.todo('supports source filter query param')
    it.todo('supports since/until query params')
    it.todo('supports limit/offset pagination')
  })

  describe('GET /api/system/events/stats', () => {
    it.todo('returns rate and counts')
  })
})
