// §2.5 NotificationFeed — Unified notification feed for dashboard
// Pure functions exported for testability; SolidJS component uses Tailwind + var(--c-*) tokens

import { setActiveWorkspace } from '../workspace/store'
import { setActiveView } from '../nav/store'
import { createSignal, onMount, onCleanup, For, Show } from 'solid-js'
import { wsStore } from '../../ws/index.js'

export interface DashboardNotification {
  id: string
  orgId: string
  orgName: string
  icon: string
  summary: string
  timestamp: number
  read: boolean
  entityId?: string
  entityType?: string
  severity?: string
  dismissed?: boolean
}

export interface EntityGroup {
  entityId: string
  entityType?: string
  unreadCount: number
  notifications: DashboardNotification[]
}

export function formatRelativeTime(ts: number, now?: number): string {
  const diff = (now ?? Date.now()) - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function sortByTimestamp(notifications: DashboardNotification[]): DashboardNotification[] {
  return [...notifications].sort((a, b) => b.timestamp - a.timestamp)
}

export function unreadCount(notifications: DashboardNotification[]): number {
  return notifications.filter((n) => !n.read).length
}

export function markAllRead(notifications: DashboardNotification[]): DashboardNotification[] {
  return notifications.map((n) => ({ ...n, read: true }))
}

export function groupByEntity(notifications: DashboardNotification[]): EntityGroup[] {
  const groups = new Map<string, DashboardNotification[]>()
  for (const n of notifications) {
    const key = n.entityId ?? '_ungrouped'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(n)
  }
  return Array.from(groups.entries()).map(([entityId, notifs]) => ({
    entityId,
    entityType: notifs[0]?.entityType,
    unreadCount: notifs.filter((n) => !n.read).length,
    notifications: sortByTimestamp(notifs)
  }))
}

export function navigateToNotification(orgId: string, orgName: string): void {
  setActiveWorkspace(orgId, orgName)
  setActiveView('workspace')
}

export const [notifications, setNotifications] = createSignal<DashboardNotification[]>([])

export default function NotificationFeed() {
  const [viewMode, setViewMode] = createSignal<'all' | 'entity'>('all')
  const [expandedGroups, setExpandedGroups] = createSignal<Set<string>>(new Set())
  const [highlightIds, setHighlightIds] = createSignal<Set<string>>(new Set())

  const sorted = () => sortByTimestamp(notifications().filter((n) => !n.dismissed))
  const groups = () => groupByEntity(notifications().filter((n) => !n.dismissed))

  // Fetch from REST API
  onMount(() => {
    fetch('/api/notifications')
      .then((r) => r.json())
      .then((data) => {
        if (data.notifications) {
          const mapped = data.notifications.map((n: Record<string, unknown>) => ({
            id: n.id as string,
            orgId: (n.source as string) || '',
            orgName: (n.source as string) || '',
            icon: n.severity === 'error' ? '🔴' : n.severity === 'warning' ? '🟡' : '🔔',
            summary: n.title as string,
            timestamp: new Date(n.timestamp as string).getTime(),
            read: n.read as boolean,
            entityId: n.entityId as string | undefined,
            entityType: n.entityType as string | undefined,
            severity: n.severity as string,
            dismissed: n.dismissed as boolean
          }))
          setNotifications(mapped)
        }
      })
      .catch(() => {})

    // WS subscription
    wsStore.subscribe(['notifications'])
    const offNew = wsStore.on('notification.new', (msg: Record<string, unknown>) => {
      const n: DashboardNotification = {
        id: (msg.id as string) || Math.random().toString(36).slice(2),
        orgId: (msg.source as string) || '',
        orgName: (msg.source as string) || '',
        icon: msg.severity === 'error' ? '🔴' : msg.severity === 'warning' ? '🟡' : '🔔',
        summary: (msg.title as string) || '',
        timestamp: Date.now(),
        read: false,
        entityId: msg.entityId as string | undefined,
        entityType: msg.entityType as string | undefined,
        severity: msg.severity as string
      }
      setNotifications((prev) => [n, ...prev])
      // Highlight animation
      setHighlightIds((prev) => new Set([...prev, n.id]))
      setTimeout(
        () =>
          setHighlightIds((prev) => {
            const next = new Set(prev)
            next.delete(n.id)
            return next
          }),
        2000
      )
    })

    onCleanup(() => {
      offNew()
      wsStore.unsubscribe(['notifications'])
    })
  })

  const handleMarkAllRead = () => setNotifications(markAllRead(notifications()))

  const markReadSingle = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    fetch('/api/notifications/read', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    }).catch(() => {})
  }

  const dismissSingle = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, dismissed: true } : n)))
    fetch('/api/notifications/dismiss', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    }).catch(() => {})
  }

  const markGroupRead = (entityId: string) => {
    const ids = notifications()
      .filter((n) => n.entityId === entityId && !n.read)
      .map((n) => n.id)
    setNotifications((prev) => prev.map((n) => (n.entityId === entityId ? { ...n, read: true } : n)))
    if (ids.length) {
      fetch('/api/notifications/read', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      }).catch(() => {})
    }
  }

  const dismissGroup = (entityId: string) => {
    const ids = notifications()
      .filter((n) => n.entityId === entityId && !n.dismissed)
      .map((n) => n.id)
    setNotifications((prev) => prev.map((n) => (n.entityId === entityId ? { ...n, dismissed: true } : n)))
    if (ids.length) {
      fetch('/api/notifications/dismiss', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      }).catch(() => {})
    }
  }

  const toggleGroup = (entityId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(entityId)) next.delete(entityId)
      else next.add(entityId)
      return next
    })
  }

  return (
    <div
      class="flex flex-col rounded-lg border"
      style={{
        background: 'var(--c-bg-raised)',
        'border-color': 'var(--c-border)',
        'border-radius': '8px'
      }}
    >
      <div class="flex items-center justify-between border-b p-3" style={{ 'border-color': 'var(--c-border)' }}>
        <h3 class="text-sm font-semibold" style={{ color: 'var(--c-text-heading)' }}>
          Notifications
          {unreadCount(notifications()) > 0 && (
            <span class="ml-1.5 rounded-full bg-red-500 px-1.5 py-0.5 text-xs text-white">
              {unreadCount(notifications())}
            </span>
          )}
        </h3>
        <div class="flex items-center gap-2">
          <button
            class={`text-xs ${viewMode() === 'all' ? 'font-bold' : 'opacity-60'}`}
            onClick={() => setViewMode('all')}
          >
            All
          </button>
          <button
            class={`text-xs ${viewMode() === 'entity' ? 'font-bold' : 'opacity-60'}`}
            onClick={() => setViewMode('entity')}
          >
            By Entity
          </button>
          <button
            class="cursor-pointer text-xs opacity-60 hover:opacity-100"
            style={{ color: 'var(--c-text)' }}
            onClick={handleMarkAllRead}
          >
            Mark all read
          </button>
        </div>
      </div>
      <div class="max-h-64 flex-1 overflow-y-auto">
        <Show when={viewMode() === 'all'}>
          {sorted().length === 0 && (
            <p class="p-3 text-xs opacity-40" style={{ color: 'var(--c-text)' }}>
              No notifications
            </p>
          )}
          <For each={sorted()}>
            {(n) => (
              <div
                class={`flex w-full items-start gap-2 border-b p-3 ${n.read ? 'opacity-50' : ''} ${highlightIds().has(n.id) ? 'bg-blue-500/10' : ''}`}
                style={{ 'border-color': 'var(--c-border)' }}
              >
                <span class="text-sm">{n.icon}</span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-xs font-medium" style={{ color: 'var(--c-text)' }}>
                    {n.summary}
                  </p>
                  <p class="text-xs opacity-50" style={{ color: 'var(--c-text)' }}>
                    {n.orgName} · {formatRelativeTime(n.timestamp)}
                  </p>
                </div>
                <div class="flex gap-1">
                  <Show when={!n.read}>
                    <button class="text-xs opacity-60 hover:opacity-100" onClick={() => markReadSingle(n.id)}>
                      ✓
                    </button>
                  </Show>
                  <button class="text-xs opacity-60 hover:opacity-100" onClick={() => dismissSingle(n.id)}>
                    ✕
                  </button>
                </div>
              </div>
            )}
          </For>
        </Show>
        <Show when={viewMode() === 'entity'}>
          <For each={groups()}>
            {(group) => (
              <div class="border-b" style={{ 'border-color': 'var(--c-border)' }}>
                <div
                  class="flex cursor-pointer items-center justify-between p-3"
                  onClick={() => toggleGroup(group.entityId)}
                >
                  <span class="text-xs font-medium">
                    {group.entityType ? `[${group.entityType}] ` : ''}
                    {group.entityId} ({group.unreadCount} unread)
                  </span>
                  <div class="flex gap-1">
                    <button
                      class="text-xs opacity-60"
                      onClick={(e) => {
                        e.stopPropagation()
                        markGroupRead(group.entityId)
                      }}
                    >
                      ✓ All
                    </button>
                    <button
                      class="text-xs opacity-60"
                      onClick={(e) => {
                        e.stopPropagation()
                        dismissGroup(group.entityId)
                      }}
                    >
                      ✕ All
                    </button>
                  </div>
                </div>
                <Show when={expandedGroups().has(group.entityId)}>
                  <For each={group.notifications}>
                    {(n) => (
                      <div
                        class={`flex items-start gap-2 border-t p-2 pl-6 ${n.read ? 'opacity-50' : ''}`}
                        style={{ 'border-color': 'var(--c-border)' }}
                      >
                        <span class="text-xs">{n.icon}</span>
                        <span class="flex-1 text-xs">{n.summary}</span>
                        <div class="flex gap-1">
                          <Show when={!n.read}>
                            <button class="text-xs opacity-60" onClick={() => markReadSingle(n.id)}>
                              ✓
                            </button>
                          </Show>
                          <button class="text-xs opacity-60" onClick={() => dismissSingle(n.id)}>
                            ✕
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
