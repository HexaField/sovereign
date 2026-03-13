import type { ThreadInfo } from './store.js'

export function getThreadDisplayName(_thread: ThreadInfo): string {
  return ''
}

export function getEntityIcon(_entityType: 'branch' | 'issue' | 'pr'): string {
  return ''
}

export function groupThreadsByWorkspace(_threads: ThreadInfo[]): Map<string, ThreadInfo[]> {
  return new Map()
}

export function formatRelativeTime(_timestamp: number): string {
  return ''
}
