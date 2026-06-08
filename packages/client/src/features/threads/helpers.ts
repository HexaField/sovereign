import type { EntityType } from '@sovereign/core'
import type { ThreadInfo } from './store.js'
export { formatRelativeTime } from '../../lib/format.js'

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

export function getEntityIcon(entityType: EntityType): string {
  switch (entityType) {
    case 'branch':
      return '🌿'
    case 'issue':
      return 'ticket'
    case 'pr':
      return 'branch'
    case 'file':
      return '📄'
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
