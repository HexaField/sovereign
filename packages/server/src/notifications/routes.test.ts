import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createNotifications, type Notifications } from './notifications.js'
import type { EventBus, BusEvent, BusHandler } from '@sovereign/core'

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

describe('Notification Routes', () => {
  let tmpDir: string
  let bus: ReturnType<typeof createTestBus>
  let notifs: Notifications

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-notif-routes-'))
    bus = createTestBus()
    // Seed rules
    const rulesDir = path.join(tmpDir, 'notifications')
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(
      path.join(rulesDir, 'rules.json'),
      JSON.stringify([
        {
          eventPattern: 'test.event',
          severity: 'info',
          titleTemplate: 'Test',
          bodyTemplate: 'Body',
          entityType: 'issue',
          entityIdField: 'payload.id'
        }
      ])
    )
    notifs = createNotifications(bus, tmpDir)
  })

  afterEach(() => {
    notifs.dispose()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function fireAndWait() {
    bus._fire({ type: 'test.event', timestamp: new Date().toISOString(), source: 'test', payload: { id: 'e1' } })
    await new Promise((r) => setTimeout(r, 20))
  }

  describe('GET /api/notifications', () => {
    it('returns notification list', async () => {
      await fireAndWait()
      const items = notifs.list()
      expect(items.length).toBeGreaterThanOrEqual(1)
      expect(items[0].title).toBe('Test')
    })

    it('filters by severity', async () => {
      await fireAndWait()
      const items = notifs.list({ severity: 'error' })
      expect(items).toHaveLength(0)
      const items2 = notifs.list({ severity: 'info' })
      expect(items2.length).toBeGreaterThanOrEqual(1)
    })

    it('filters by read status', async () => {
      await fireAndWait()
      const items = notifs.list({ read: false })
      expect(items.length).toBeGreaterThanOrEqual(1)
      const items2 = notifs.list({ read: true })
      expect(items2).toHaveLength(0)
    })

    it('supports limit/offset pagination', async () => {
      await fireAndWait()
      await fireAndWait()
      const items = notifs.list({ limit: 1, offset: 0 })
      expect(items).toHaveLength(1)
    })

    it('groupBy=entity returns grouped notifications', async () => {
      await fireAndWait()
      const groups = notifs.listGrouped()
      expect(groups.length).toBeGreaterThanOrEqual(1)
    })

    it('entity groups include entityId, entityType, unreadCount', async () => {
      await fireAndWait()
      const groups = notifs.listGrouped()
      const g = groups.find((g) => g.entityId === 'e1')
      expect(g).toBeDefined()
      expect(g!.entityType).toBe('issue')
      expect(g!.unreadCount).toBeGreaterThanOrEqual(1)
    })
  })

  describe('PATCH /api/notifications/read', () => {
    it('marks notifications as read', async () => {
      await fireAndWait()
      const items = notifs.list()
      expect(items[0].read).toBe(false)
      notifs.markRead([items[0].id])
      const items2 = notifs.list()
      const found = items2.find((n) => n.id === items[0].id)
      expect(found!.read).toBe(true)
    })
  })

  describe('PATCH /api/notifications/dismiss', () => {
    it('dismisses notifications', async () => {
      await fireAndWait()
      const items = notifs.list()
      const id = items[0].id
      notifs.dismiss([id])
      const items2 = notifs.list()
      expect(items2.find((n) => n.id === id)).toBeUndefined()
    })
  })

  describe('GET /api/notifications/unread-count', () => {
    it('returns count', async () => {
      await fireAndWait()
      expect(notifs.unreadCount()).toBeGreaterThanOrEqual(1)
    })
  })
})
