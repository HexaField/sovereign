import { Show } from 'solid-js'
import type { Component } from 'solid-js'
import { activeWorkspace } from '../store.js'

export interface NotificationItem {
  id: string
  icon: string
  summary: string
  timestamp: number
  read: boolean
  entityRef?: string
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

const NotificationsPanel: Component = () => {
  const ws = () => activeWorkspace()

  return (
    <div class="flex h-full flex-col">
      <div class="flex items-center justify-between border-b px-3 py-2" style={{ 'border-color': 'var(--c-border)' }}>
        <span class="text-xs font-medium" style={{ color: 'var(--c-text-heading)' }}>
          Notifications
        </span>
        <button class="text-xs" style={{ color: 'var(--c-accent)' }}>
          Mark all read
        </button>
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
          <p class="text-xs" style={{ color: 'var(--c-text-muted)' }}>
            No notifications
          </p>
        </Show>
      </div>
    </div>
  )
}

export default NotificationsPanel
