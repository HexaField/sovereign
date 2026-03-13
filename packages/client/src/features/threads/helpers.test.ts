import { describe, it, expect } from 'vitest'
import type { ThreadInfo } from './store.js'
import { getThreadDisplayName, getEntityIcon, groupThreadsByWorkspace, formatRelativeTime } from './helpers.js'

function makeThread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    key: 'test',
    entities: [],
    lastActivity: Date.now(),
    unreadCount: 0,
    agentStatus: 'idle',
    ...overrides
  } as ThreadInfo
}

describe('§5.5 Thread Helpers', () => {
  it('getThreadDisplayName MUST derive name from primary entity (branch name)', () => {
    const t = makeThread({ entities: [{ orgId: 'o', projectId: 'p', entityType: 'branch', entityRef: 'feat/login' }] })
    expect(getThreadDisplayName(t)).toBe('feat/login')
  })

  it('getThreadDisplayName MUST derive name from issue title + #number', () => {
    const t = makeThread({ entities: [{ orgId: 'o', projectId: 'p', entityType: 'issue', entityRef: 'Fix bug #42' }] })
    expect(getThreadDisplayName(t)).toBe('Fix bug #42')
  })

  it('getThreadDisplayName MUST derive name from PR title + #number', () => {
    const t = makeThread({ entities: [{ orgId: 'o', projectId: 'p', entityType: 'pr', entityRef: 'Add feature #7' }] })
    expect(getThreadDisplayName(t)).toBe('Add feature #7')
  })

  it('getThreadDisplayName MUST return label or "Main" for global threads', () => {
    expect(getThreadDisplayName(makeThread({ label: 'My Thread' }))).toBe('My Thread')
    expect(getThreadDisplayName(makeThread())).toBe('Main')
  })

  it('getEntityIcon MUST return 🌿 for branch', () => {
    expect(getEntityIcon('branch')).toBe('🌿')
  })

  it('getEntityIcon MUST return 🎫 for issue', () => {
    expect(getEntityIcon('issue')).toBe('🎫')
  })

  it('getEntityIcon MUST return 🔀 for pr', () => {
    expect(getEntityIcon('pr')).toBe('🔀')
  })

  it('groupThreadsByWorkspace MUST group by {orgId}/{projectId} key', () => {
    const threads = [
      makeThread({
        key: 'a',
        entities: [{ orgId: 'org1', projectId: 'proj1', entityType: 'branch', entityRef: 'main' }]
      }),
      makeThread({ key: 'b', entities: [{ orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '#1' }] }),
      makeThread({ key: 'c', entities: [{ orgId: 'org2', projectId: 'proj2', entityType: 'pr', entityRef: '#3' }] })
    ]
    const grouped = groupThreadsByWorkspace(threads)
    expect(grouped.get('org1/proj1')?.length).toBe(2)
    expect(grouped.get('org2/proj2')?.length).toBe(1)
  })

  it('groupThreadsByWorkspace MUST group global threads under "global" key', () => {
    const threads = [makeThread({ key: 'g1' }), makeThread({ key: 'g2' })]
    const grouped = groupThreadsByWorkspace(threads)
    expect(grouped.get('global')?.length).toBe(2)
  })

  it('formatRelativeTime MUST format as "Just now" for recent timestamps', () => {
    expect(formatRelativeTime(Date.now() - 5000)).toBe('Just now')
  })

  it('formatRelativeTime MUST format as "2m ago", "1h ago" for older timestamps', () => {
    expect(formatRelativeTime(Date.now() - 2 * 60 * 1000)).toBe('2m ago')
    expect(formatRelativeTime(Date.now() - 60 * 60 * 1000)).toBe('1h ago')
  })

  it('formatRelativeTime MUST format as "Yesterday" for yesterday', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    yesterday.setHours(12, 0, 0, 0)
    expect(formatRelativeTime(yesterday.getTime())).toBe('Yesterday')
  })

  it('formatRelativeTime MUST format as "Mon, Mar 10" for older dates', () => {
    // Use a known date: March 10, 2025 was a Monday
    const date = new Date(2025, 2, 10, 12, 0, 0)
    expect(formatRelativeTime(date.getTime())).toBe('Mon, Mar 10')
  })
})
