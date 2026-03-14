import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createNotifications, type Notifications } from './notifications.js'
import { seedDefaultRules } from './rules.js'
import type { EventBus, BusEvent, BusHandler } from '@template/core'

function createTestBus(): EventBus & { _fire(event: BusEvent): void } {
  const handlers: Array<{ pattern: string; handler: BusHandler }> = []
  return {
    emit(event: BusEvent) {
      for (const h of handlers) {
        if (h.pattern === '*' || h.pattern === event.type) h.handler(event)
      }
    },
    on(pattern: string, handler: BusHandler) {
      const entry = { pattern, handler }
      handlers.push(entry)
      return () => {
        const idx = handlers.indexOf(entry)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },
    once: vi.fn() as any,
    replay: vi.fn() as any,
    history: vi.fn().mockReturnValue([]),
    _fire(event: BusEvent) {
      for (const h of handlers) {
        if (h.pattern === '*' || h.pattern === event.type) h.handler(event)
      }
    }
  } as any
}

describe('Notification Entity Binding', () => {
  let tmpDir: string
  let bus: ReturnType<typeof createTestBus>
  let notifs: Notifications

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-entity-test-'))
    bus = createTestBus()
    // Use default rules which have entity bindings
    seedDefaultRules(tmpDir)
    notifs = createNotifications(bus, tmpDir)
  })

  afterEach(() => {
    notifs.dispose()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('entity fields from events', () => {
    it('notification created from issue.created includes entityId and entityType', async () => {
      bus._fire({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { id: 'issue-123', title: 'Bug report' }
      })
      await new Promise((r) => setTimeout(r, 20))
      const items = notifs.list()
      expect(items.length).toBeGreaterThanOrEqual(1)
      const n = items.find((n) => n.entityId === 'issue-123')
      expect(n).toBeDefined()
      expect(n!.entityType).toBe('issue')
    })

    it('notification created from review.created includes entityId and entityType', async () => {
      bus._fire({
        type: 'review.created',
        timestamp: new Date().toISOString(),
        source: 'review',
        payload: { id: 'pr-456', title: 'Fix something' }
      })
      await new Promise((r) => setTimeout(r, 20))
      const items = notifs.list()
      const n = items.find((n) => n.entityId === 'pr-456')
      expect(n).toBeDefined()
      expect(n!.entityType).toBe('pr')
    })

    it('notification created from scheduler.job.failed has no entity', async () => {
      bus._fire({
        type: 'scheduler.job.failed',
        timestamp: new Date().toISOString(),
        source: 'scheduler',
        payload: { jobName: 'backup' }
      })
      await new Promise((r) => setTimeout(r, 20))
      const items = notifs.list()
      const n = items.find((n) => n.title === 'Job Failed')
      expect(n).toBeDefined()
      expect(n!.entityId).toBeUndefined()
      expect(n!.entityType).toBeUndefined()
    })
  })

  describe('default rules', () => {
    it('default rules file seeded on first startup', () => {
      const rulesPath = path.join(tmpDir, 'notifications', 'rules.json')
      expect(fs.existsSync(rulesPath)).toBe(true)
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'))
      expect(rules.length).toBeGreaterThan(0)
    })

    it('default rules not overwritten if file exists', () => {
      const rulesPath = path.join(tmpDir, 'notifications', 'rules.json')
      fs.writeFileSync(
        rulesPath,
        JSON.stringify([{ eventPattern: 'custom', severity: 'info', titleTemplate: 'X', bodyTemplate: 'Y' }])
      )
      seedDefaultRules(tmpDir)
      const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'))
      expect(rules).toHaveLength(1)
      expect(rules[0].eventPattern).toBe('custom')
    })
  })

  describe('entity grouping', () => {
    it('entity grouping query groups by entityId', async () => {
      bus._fire({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { id: 'e1', title: 'A' }
      })
      bus._fire({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { id: 'e1', title: 'B' }
      })
      bus._fire({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { id: 'e2', title: 'C' }
      })
      await new Promise((r) => setTimeout(r, 30))
      const groups = notifs.listGrouped()
      const g1 = groups.find((g) => g.entityId === 'e1')
      const g2 = groups.find((g) => g.entityId === 'e2')
      expect(g1).toBeDefined()
      expect(g2).toBeDefined()
      expect(g1!.notifications.length).toBeGreaterThanOrEqual(2)
    })

    it('entity grouping returns unread count per group', async () => {
      bus._fire({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { id: 'e1', title: 'A' }
      })
      bus._fire({
        type: 'issue.created',
        timestamp: new Date().toISOString(),
        source: 'issues',
        payload: { id: 'e1', title: 'B' }
      })
      await new Promise((r) => setTimeout(r, 30))
      const groups = notifs.listGrouped()
      const g = groups.find((g) => g.entityId === 'e1')
      expect(g!.unreadCount).toBeGreaterThanOrEqual(2)
    })
  })
})
