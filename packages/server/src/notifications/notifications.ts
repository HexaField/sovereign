import { randomUUID } from 'node:crypto'
import type { EventBus, BusEvent } from '@template/core'
import type { Notification } from './types.js'
import { createNotificationStore, type NotificationStore } from './store.js'
import { createRuleEngine, interpolate, type RuleEngine } from './rules.js'
import { createPushManager, type PushManager, type PushSubscription } from './push.js'

export interface NotificationsConfig {
  ttlMs?: number
  onNotification?: (n: Notification) => void
}

export interface Notifications {
  list(filter?: { severity?: string; read?: boolean; limit?: number; offset?: number }): Notification[]
  unreadCount(): number
  markRead(ids: string[]): void
  dismiss(ids: string[]): void
  pushSubscribe(deviceId: string, subscription: PushSubscription): void
  pushUnsubscribe(deviceId: string): void
  dispose(): void
  /** Exposed for testing */
  _store: NotificationStore
  _ruleEngine: RuleEngine
  _pushManager: PushManager
}

export const createNotifications = (bus: EventBus, dataDir: string, config?: NotificationsConfig): Notifications => {
  const store = createNotificationStore(dataDir)
  const ruleEngine = createRuleEngine(dataDir)
  const pushManager = createPushManager()

  // In-memory cache loaded from disk
  let notifications: Notification[] = store.readAll()

  const persist = (): void => {
    store.overwrite(notifications)
  }

  const handleEvent = (event: BusEvent): void => {
    // Don't generate notifications for void-classified webhook events
    if (event.type === 'webhook.received' && (event.payload as any)?.classification === 'void') return

    const rule = ruleEngine.match(event)
    if (!rule) return

    const notification: Notification = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      severity: rule.severity,
      title: interpolate(rule.titleTemplate, event),
      body: interpolate(rule.bodyTemplate, event),
      source: event.source,
      read: false,
      dismissed: false,
      ...(rule.group ? { group: rule.group } : {})
    }

    notifications.push(notification)
    store.append(notification)
    config?.onNotification?.(notification)
  }

  // Subscribe to all bus events — async, non-blocking
  const unsub = bus.on('*', (event) => {
    // Use queueMicrotask to not block the bus
    queueMicrotask(() => handleEvent(event))
  })

  // TTL-based auto-archive
  const archiveExpired = (): void => {
    if (!config?.ttlMs) return
    const cutoff = Date.now() - config.ttlMs
    const before = notifications.length
    notifications = notifications.filter((n) => new Date(n.timestamp).getTime() > cutoff)
    if (notifications.length !== before) persist()
  }

  const ttlInterval = config?.ttlMs ? setInterval(archiveExpired, Math.min(config.ttlMs, 60000)) : null

  const list = (filter?: { severity?: string; read?: boolean; limit?: number; offset?: number }): Notification[] => {
    let result = notifications.filter((n) => !n.dismissed)
    if (filter?.severity) result = result.filter((n) => n.severity === filter.severity)
    if (filter?.read !== undefined) result = result.filter((n) => n.read === filter.read)
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? result.length
    return result.slice(offset, offset + limit)
  }

  const unreadCount = (): number => {
    return notifications.filter((n) => !n.read && !n.dismissed).length
  }

  const markRead = (ids: string[]): void => {
    const idSet = new Set(ids)
    for (const n of notifications) {
      if (idSet.has(n.id)) n.read = true
    }
    persist()
  }

  const dismiss = (ids: string[]): void => {
    const idSet = new Set(ids)
    for (const n of notifications) {
      if (idSet.has(n.id)) n.dismissed = true
    }
    persist()
  }

  const pushSubscribe = (deviceId: string, sub: PushSubscription): void => {
    pushManager.subscribe(deviceId, sub)
  }

  const pushUnsubscribe = (deviceId: string): void => {
    pushManager.unsubscribe(deviceId)
  }

  const dispose = (): void => {
    unsub()
    ruleEngine.dispose()
    if (ttlInterval) clearInterval(ttlInterval)
  }

  return {
    list,
    unreadCount,
    markRead,
    dismiss,
    pushSubscribe,
    pushUnsubscribe,
    dispose,
    _store: store,
    _ruleEngine: ruleEngine,
    _pushManager: pushManager
  }
}
