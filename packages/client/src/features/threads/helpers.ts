import type { ThreadInfo } from './store.js'

export function getThreadDisplayName(thread: ThreadInfo): string {
  if (!thread.entities || thread.entities.length === 0) {
    return thread.label || 'Main'
  }
  const primary = thread.entities[0]
  switch (primary.entityType) {
    case 'branch':
      return primary.entityRef
    case 'issue':
      return `${primary.entityRef}`
    case 'pr':
      return `${primary.entityRef}`
    default:
      return thread.label || 'Main'
  }
}

export function getEntityIcon(entityType: 'branch' | 'issue' | 'pr'): string {
  switch (entityType) {
    case 'branch':
      return '🌿'
    case 'issue':
      return 'ticket'
    case 'pr':
      return 'branch'
    default:
      return ''
  }
}

export function groupThreadsByWorkspace(threads: ThreadInfo[]): Map<string, ThreadInfo[]> {
  const map = new Map<string, ThreadInfo[]>()
  for (const thread of threads) {
    if (!thread.entities || thread.entities.length === 0) {
      const list = map.get('global') || []
      list.push(thread)
      map.set('global', list)
    } else {
      const primary = thread.entities[0]
      const key = `${primary.orgId}/${primary.projectId}`
      const list = map.get(key) || []
      list.push(thread)
      map.set(key, list)
    }
  }
  return map
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)

  if (seconds < 60) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`

  // Check calendar days before falling back to hours
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)

  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  if (isToday) return `${hours}h ago`

  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()

  if (isYesterday) return 'Yesterday'

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}`
}
