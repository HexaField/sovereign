// Notification REST routes

import { Router } from 'express'
import type { Notifications } from './notifications.js'

export function createNotificationRoutes(notifications: Notifications): Router {
  const router = Router()

  router.get('/api/notifications', (req, res) => {
    const { severity, read, limit, offset, groupBy } = req.query as Record<string, string | undefined>

    if (groupBy === 'entity') {
      const groups = notifications.listGrouped()
      res.json({ groups })
      return
    }

    const filter: Record<string, unknown> = {}
    if (severity) filter.severity = severity
    if (read !== undefined) filter.read = read === 'true'
    if (limit) filter.limit = Number(limit)
    if (offset) filter.offset = Number(offset)

    const items = notifications.list(filter as Parameters<typeof notifications.list>[0])
    res.json({ notifications: items, total: items.length })
  })

  router.patch('/api/notifications/read', (req, res) => {
    const { ids } = req.body as { ids: string[] }
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' })
      return
    }
    notifications.markRead(ids)
    res.json({ ok: true })
  })

  router.patch('/api/notifications/dismiss', (req, res) => {
    const { ids } = req.body as { ids: string[] }
    if (!Array.isArray(ids)) {
      res.status(400).json({ error: 'ids must be an array' })
      return
    }
    notifications.dismiss(ids)
    res.json({ ok: true })
  })

  router.get('/api/notifications/unread-count', (_req, res) => {
    res.json({ count: notifications.unreadCount() })
  })

  return router
}
