// Dashboard helper functions — extracted from original DashboardView.tsx for re-export

// ── §7.2 Clock ──

export function formatClock(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date)
}

// ── §7.3 HealthPanel ──

export type ServiceStatus = 'healthy' | 'degraded' | 'error'

export function formatUptime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0 || days > 0) parts.push(`${hours}h`)
  parts.push(`${minutes}m`)
  return parts.join(' ')
}

export function getStatusColor(status: ServiceStatus): string {
  switch (status) {
    case 'healthy':
      return 'green'
    case 'degraded':
      return 'amber'
    case 'error':
      return 'red'
  }
}

// ── §7.4 ActivityFeed ──

export const MAX_FEED_EVENTS = 50

export type EventType =
  | 'git.status.changed'
  | 'chat.status'
  | 'review.created'
  | 'review.updated'
  | 'issue.updated'
  | 'issue.created'
  | 'worktree.created'
  | 'worktree.removed'

export interface ActivityEvent {
  type: EventType
  description?: string
  workspace?: string
  timestamp: number
  entityId?: string
  title?: string
}

export function getEventIcon(eventType: EventType): string {
  switch (eventType) {
    case 'git.status.changed':
      return '📝'
    case 'chat.status':
      return '🤖'
    case 'review.created':
    case 'review.updated':
      return '👀'
    case 'issue.updated':
    case 'issue.created':
      return '🎫'
    case 'worktree.created':
      return '🌳'
    case 'worktree.removed':
      return '🪓'
    default:
      return '📌'
  }
}

export function getEventDescription(event: ActivityEvent): string {
  if (event.description) return event.description
  switch (event.type) {
    case 'git.status.changed':
      return `Files changed${event.workspace ? ` in ${event.workspace}` : ''}`
    case 'chat.status':
      return 'Agent activity'
    case 'review.created':
      return `Review created${event.title ? `: ${event.title}` : ''}`
    case 'review.updated':
      return `Review updated${event.title ? `: ${event.title}` : ''}`
    case 'issue.created':
      return `Issue created${event.title ? `: ${event.title}` : ''}`
    case 'issue.updated':
      return `Issue updated${event.title ? `: ${event.title}` : ''}`
    case 'worktree.created':
      return 'Worktree created'
    case 'worktree.removed':
      return 'Worktree removed'
    default:
      return 'Unknown event'
  }
}

export function formatEventTime(ts: number): string {
  const diff = Date.now() - ts
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ── §7.5 Notifications ──

export interface Notification {
  id: string
  threadId: string
  entityId?: string
  message: string
  read: boolean
  timestamp: number
  actionUrl?: string
}

export function groupNotificationsByThread(notifications: Notification[]): Map<string, Notification[]> {
  const map = new Map<string, Notification[]>()
  for (const n of notifications) {
    const list = map.get(n.threadId) ?? []
    list.push(n)
    map.set(n.threadId, list)
  }
  return map
}

export function isUnread(notification: Notification): boolean {
  return !notification.read
}

// ── §7.6 Active Agents ──

export type AgentStatus = 'working' | 'thinking' | 'idle'

export function formatAgentDuration(startTime: number): string {
  const diff = Date.now() - startTime
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function getAgentStatusLabel(status: AgentStatus): string {
  switch (status) {
    case 'working':
      return 'Working'
    case 'thinking':
      return 'Thinking'
    case 'idle':
      return 'Idle'
  }
}

// ── §7.7 ThreadQuickSwitch ──

export const QUICK_SWITCH_LIMIT = 5

export interface ThreadInfo {
  id: string
  name: string
  entityIcon?: string
  lastActivity: number
}

export function getRecentThreads(threads: ThreadInfo[], limit: number = QUICK_SWITCH_LIMIT): ThreadInfo[] {
  return [...threads].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, limit)
}
