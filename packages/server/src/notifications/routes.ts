// Notification REST routes

import { Router } from 'express'
import type { Notifications } from './notifications.js'
import type { PushManager } from './push.js'

export function createNotificationRoutes(notifications: Notifications, pushManager?: PushManager): Router {
  const router = Router()

  // VAPID public key for push subscription
  router.get('/api/notifications/vapid-public-key', (_req, res) => {
    const key = pushManager?.getVapidPublicKey()
    if (!key) {
      res.status(503).json({ error: 'Push notifications not configured' })
      return
    }
    res.json({ publicKey: key })
  })

  // Subscribe a device for push notifications
  router.post('/api/notifications/push/subscribe', (req, res) => {
    const { deviceId, subscription } = req.body as { deviceId?: string; subscription?: any }
    if (!deviceId || !subscription?.endpoint || !subscription?.keys) {
      res.status(400).json({ error: 'deviceId and subscription (with endpoint + keys) required' })
      return
    }
    pushManager?.subscribe(deviceId, subscription)
    res.json({ ok: true })
  })

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
