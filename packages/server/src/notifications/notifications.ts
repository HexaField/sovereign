import { randomUUID } from 'node:crypto'
import type { EventBus, BusEvent } from '@sovereign/core'
import type { Notification } from './types.js'
import { createNotificationStore, type NotificationStore } from './store.js'
import { createRuleEngine, interpolate, seedDefaultRules, type RuleEngine } from './rules.js'
import { createPushManager, type PushManager, type PushSubscription } from './push.js'

export interface NotificationsConfig {
  ttlMs?: number
  onNotification?: (n: Notification) => void
}

export interface Notifications {
  list(filter?: {
    severity?: string
    read?: boolean
    limit?: number
    offset?: number
    groupBy?: string
  }): Notification[]
  listGrouped(): Array<{ entityId: string; entityType?: string; unreadCount: number; notifications: Notification[] }>
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

const getByPath = (obj: unknown, pathStr: string): unknown => {
  const parts = pathStr.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

export const createNotifications = (bus: EventBus, dataDir: string, config?: NotificationsConfig): Notifications => {
  // Seed default rules on first startup
  seedDefaultRules(dataDir)

  const store = createNotificationStore(dataDir)
  const ruleEngine = createRuleEngine(dataDir)
  const pushManager = createPushManager()

  let notifications: Notification[] = store.readAll()

  const persist = (): void => {
    store.overwrite(notifications)
  }

  const handleEvent = (event: BusEvent): void => {
    if (event.type === 'webhook.received' && (event.payload as Record<string, unknown>)?.classification === 'void')
      return

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

    // Populate entity fields from rule config
    if (rule.entityType) {
      notification.entityType = rule.entityType
    }
    if (rule.entityIdField) {
      const entityId = getByPath(event, rule.entityIdField)
      if (entityId !== undefined) {
        notification.entityId = String(entityId)
      }
    }

    notifications.push(notification)
    store.append(notification)
    config?.onNotification?.(notification)

    // Emit bus event for WS broadcast
    bus.emit({
      type: 'notification.created',
      timestamp: new Date().toISOString(),
      source: 'notifications',
      payload: notification
    })
  }

  const unsub = bus.on('*', (event) => {
    queueMicrotask(() => handleEvent(event))
  })

  const archiveExpired = (): void => {
    if (!config?.ttlMs) return
    const cutoff = Date.now() - config.ttlMs
    const before = notifications.length
    notifications = notifications.filter((n) => new Date(n.timestamp).getTime() > cutoff)
    if (notifications.length !== before) persist()
  }

  const ttlInterval = config?.ttlMs ? setInterval(archiveExpired, Math.min(config.ttlMs, 60000)) : null

  const list = (filter?: {
    severity?: string
    read?: boolean
    limit?: number
    offset?: number
    groupBy?: string
  }): Notification[] => {
    let result = notifications.filter((n) => !n.dismissed)
    if (filter?.severity) result = result.filter((n) => n.severity === filter.severity)
    if (filter?.read !== undefined) result = result.filter((n) => n.read === filter.read)
    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? result.length
    return result.slice(offset, offset + limit)
  }

  const listGrouped = (): Array<{
    entityId: string
    entityType?: string
    unreadCount: number
    notifications: Notification[]
  }> => {
    const active = notifications.filter((n) => !n.dismissed)
    const groups = new Map<string, Notification[]>()
    for (const n of active) {
      const key = n.entityId ?? '_ungrouped'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(n)
    }
    return Array.from(groups.entries()).map(([entityId, notifs]) => ({
      entityId,
      entityType: notifs[0]?.entityType,
      unreadCount: notifs.filter((n) => !n.read).length,
      notifications: notifs
    }))
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
    listGrouped,
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
