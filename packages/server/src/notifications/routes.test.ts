import { describe, it } from 'vitest'

describe('Notification Routes', () => {
  describe('GET /api/notifications', () => {
    it.todo('returns notification list')
    it.todo('filters by severity')
    it.todo('filters by read status')
    it.todo('supports limit/offset pagination')
    it.todo('groupBy=entity returns grouped notifications')
    it.todo('entity groups include entityId, entityType, unreadCount')
  })

  describe('PATCH /api/notifications/read', () => {
    it.todo('marks notifications as read')
  })

  describe('PATCH /api/notifications/dismiss', () => {
    it.todo('dismisses notifications')
  })

  describe('GET /api/notifications/unread-count', () => {
    it.todo('returns count')
  })
})
