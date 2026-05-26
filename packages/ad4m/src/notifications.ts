import type { EventBus, BusEvent } from '@sovereign/core'
import type { Notifications } from '@sovereign/notifications'
import { randomUUID } from 'node:crypto'

const seenNotificationIds = new Set<string>()

export function startNotificationBridge(bus: EventBus, notifications: Notifications): () => void {
  const unsub = bus.on('ad4m.notification.triggered', (event: BusEvent) => {
    const payload = event.payload as {
      notification?: { notification?: { id?: string; description?: string; appName?: string } }
    }
    const n = payload?.notification?.notification
    if (!n) return

    const dedupeKey = n.id ?? JSON.stringify(n)
    if (seenNotificationIds.has(dedupeKey)) return
    seenNotificationIds.add(dedupeKey)

    const sov = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      severity: 'info' as const,
      title: `AD4M: ${n.appName ?? 'Notification'}`,
      body: n.description ?? '',
      source: 'ad4m',
      read: false,
      dismissed: false
    }

    try {
      notifications._store.append(sov)
      bus.emit({ type: 'notification.created', source: 'ad4m', timestamp: new Date().toISOString(), payload: sov })
    } catch (err) {
      console.error('[ad4m] notification bridge error:', err)
    }
  })

  return unsub
}
