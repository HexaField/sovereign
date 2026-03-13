// §2.5 NotificationFeed — Unified notification feed for dashboard
// Pure functions exported for testability; SolidJS component uses Tailwind + var(--c-*) tokens

import { setActiveWorkspace } from '../workspace/store'
import { setActiveView } from '../nav/store'

export interface DashboardNotification {
  id: string
  orgId: string
  orgName: string
  icon: string
  summary: string
  timestamp: number
  read: boolean
  entityId?: string
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

export function navigateToNotification(orgId: string, orgName: string): void {
  setActiveWorkspace(orgId, orgName)
  setActiveView('workspace')
}

import { createSignal } from 'solid-js'

export const [notifications, setNotifications] = createSignal<DashboardNotification[]>([])

export default function NotificationFeed() {
  const sorted = () => sortByTimestamp(notifications())
  const handleMarkAllRead = () => setNotifications(markAllRead(notifications()))

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
        <button
          class="cursor-pointer text-xs opacity-60 hover:opacity-100"
          style={{ color: 'var(--c-text)' }}
          onClick={handleMarkAllRead}
        >
          Mark all read
        </button>
      </div>
      <div class="max-h-64 flex-1 overflow-y-auto">
        {sorted().length === 0 && (
          <p class="p-3 text-xs opacity-40" style={{ color: 'var(--c-text)' }}>
            No notifications
          </p>
        )}
        {sorted().map((n) => (
          <button
            class={`flex w-full cursor-pointer items-start gap-2 border-b p-3 text-left hover:brightness-110 ${n.read ? 'opacity-50' : ''}`}
            style={{ 'border-color': 'var(--c-border)' }}
            onClick={() => navigateToNotification(n.orgId, n.orgName)}
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
          </button>
        ))}
      </div>
    </div>
  )
}
