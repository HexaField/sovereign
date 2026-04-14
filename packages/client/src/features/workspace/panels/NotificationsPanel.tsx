import { Show, For, createSignal, onMount, onCleanup, type JSX } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'
import { wsStore } from '../../../ws/index.js'
import { AlertCircleIcon, AlertIcon, WarningIcon, InfoIcon } from '../../../ui/icons.js'

export type NotificationPriority = 'info' | 'warning' | 'error' | 'critical'

export interface NotificationItem {
  id: string
  icon: JSX.Element
  summary: string
  timestamp: number
  read: boolean
  priority: NotificationPriority
  entityRef?: string
  entityId?: string
  entityType?: string
  dismissed?: boolean
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const PRIORITY_ORDER: Record<NotificationPriority, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3
}

function mapSeverityToIcon(severity: string): JSX.Element {
  if (severity === 'critical') return <AlertCircleIcon class="h-3.5 w-3.5 text-red-400" />
  if (severity === 'error') return <AlertIcon class="h-3.5 w-3.5 text-red-400" />
  if (severity === 'warning') return <WarningIcon class="h-3.5 w-3.5 text-yellow-400" />
  return <InfoIcon class="h-3.5 w-3.5 text-cyan-400" />
}

function mapSeverityToPriority(severity: string): NotificationPriority {
  if (severity === 'critical' || severity === 'error' || severity === 'warning' || severity === 'info')
    return severity as NotificationPriority
  return 'info'
}

const NotificationsPanel: Component = () => {
  const ws = () => activeWorkspace()
  const [items, setItems] = createSignal<NotificationItem[]>([])
  const [priorityFilter, setPriorityFilter] = createSignal<NotificationPriority | 'all'>('all')
  const unreadBadge = () => items().filter((n) => !n.read && !n.dismissed).length

  onMount(() => {
    fetch('/api/notifications/unread-count')
      .then((r) => r.json())
      .then(() => {})
      .catch(() => {})

    fetch('/api/notifications?limit=50')
      .then((r) => r.json())
      .then((data) => {
        if (data.notifications) {
          setItems(
            data.notifications.map((n: Record<string, unknown>) => ({
              id: n.id as string,
              icon: mapSeverityToIcon(n.severity as string),
              summary: n.title as string,
              timestamp: new Date(n.timestamp as string).getTime(),
              read: n.read as boolean,
              priority: mapSeverityToPriority(n.severity as string),
              entityId: n.entityId as string | undefined,
              entityType: n.entityType as string | undefined,
              dismissed: n.dismissed as boolean
            }))
          )
        }
      })
      .catch(() => {})

    wsStore.subscribe(['notifications'])
    const offNew = wsStore.on('notification.new', (msg: Record<string, unknown>) => {
      const severity = (msg.severity as string) || 'info'
      const item: NotificationItem = {
        id: (msg.id as string) || Math.random().toString(36).slice(2),
        icon: mapSeverityToIcon(severity),
        summary: (msg.title as string) || '',
        timestamp: Date.now(),
        read: false,
        priority: mapSeverityToPriority(severity),
        entityId: msg.entityId as string | undefined,
        entityType: msg.entityType as string | undefined
      }
      setItems((prev) => [item, ...prev])
    })

    onCleanup(() => {
      offNew()
      wsStore.unsubscribe(['notifications'])
    })
  })

  const markAllRead = () => {
    const ids = items()
      .filter((n) => !n.read)
      .map((n) => n.id)
    setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    if (ids.length) {
      fetch('/api/notifications/read', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids })
      }).catch(() => {})
    }
  }

  const markRead = (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    fetch('/api/notifications/read', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    }).catch(() => {})
  }

  const dismiss = (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, dismissed: true } : n)))
    fetch('/api/notifications/dismiss', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    }).catch(() => {})
  }

  const visible = () => {
    let result = items().filter((n) => !n.dismissed)
    const filter = priorityFilter()
    if (filter !== 'all') {
      result = result.filter((n) => n.priority === filter)
    }
    // Sort by priority (critical first), then by timestamp (newest first)
    return result.sort((a, b) => {
      const pd = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
      if (pd !== 0) return pd
      return b.timestamp - a.timestamp
    })
  }

  const filterButtons: Array<{ label: string; value: NotificationPriority | 'all' }> = [
    { label: 'All', value: 'all' },
    { label: '🔴', value: 'critical' },
    { label: '❌', value: 'error' },
    { label: '⚠️', value: 'warning' },
    { label: 'ℹ️', value: 'info' }
  ]

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Notifications
          <Show when={unreadBadge() > 0}>
            <span class="ml-1 rounded-full bg-red-500 px-1.5 py-0.5 text-xs text-white" data-testid="unread-badge">
              {unreadBadge()}
            </span>
          </Show>
        </span>
        <button class="text-xs" style={{ color: 'var(--c-accent)' }} onClick={markAllRead}>
          Mark all read
        </button>
      </div>

      {/* Priority filter bar */}
      <div class="flex gap-1 border-b px-3 py-1.5" style={{ 'border-color': 'var(--c-border)' }}>
        <For each={filterButtons}>
          {(btn) => (
            <button
              class="rounded px-1.5 py-0.5 text-[10px]"
              style={{
                background: priorityFilter() === btn.value ? 'var(--c-accent)' : 'var(--c-hover-bg)',
                color: priorityFilter() === btn.value ? 'var(--c-text-on-accent)' : 'var(--c-text-muted)'
              }}
              onClick={() => setPriorityFilter(btn.value)}
              data-testid={`filter-${btn.value}`}
            >
              {btn.label}
            </button>
          )}
        </For>
      </div>

      <div class="flex-1 overflow-auto p-2">
        <Show
          when={ws()}
          fallback={
            <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
              No workspace
            </p>
          }
        >
          <Show
            when={visible().length > 0}
            fallback={
              <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
                No notifications
              </p>
            }
          >
            <For each={visible()}>
              {(n) => (
                <div
                  class={`flex items-start gap-2 border-b p-2 ${n.read ? 'opacity-50' : ''}`}
                  style={{ 'border-color': 'var(--c-border)' }}
                  data-testid={`notification-${n.id}`}
                  data-priority={n.priority}
                >
                  <span class="text-xs">{n.icon}</span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-xs" style={{ color: 'var(--c-text)' }}>
                      {n.summary}
                    </p>
                    <p class="text-xs opacity-50">{formatRelativeTime(n.timestamp)}</p>
                  </div>
                  <div class="flex gap-1">
                    <Show when={!n.read}>
                      <button class="text-xs opacity-60" onClick={() => markRead(n.id)}>
                        ✓
                      </button>
                    </Show>
                    <button class="text-xs opacity-60" onClick={() => dismiss(n.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default NotificationsPanel
