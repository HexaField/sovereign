import { describe, it } from 'vitest'

describe('Notification Entity Binding', () => {
  describe('entity fields from events', () => {
    it.todo('notification created from issue.created includes entityId and entityType')
    it.todo('notification created from review.created includes entityId and entityType')
    it.todo('notification created from scheduler.job.failed has no entity')
  })

  describe('default rules', () => {
    it.todo('default rules file seeded on first startup')
    it.todo('default rules not overwritten if file exists')
  })

  describe('entity grouping', () => {
    it.todo('entity grouping query groups by entityId')
    it.todo('entity grouping returns unread count per group')
  })
})
