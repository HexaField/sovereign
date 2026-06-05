import type { ThreadInfo } from '@sovereign/core'

/**
 * Build a canonical {@link ThreadInfo} for tests. Every field defaults, so a
 * test only specifies what it cares about. Because it is typed against the
 * shared `@sovereign/core` `ThreadInfo`, a future field rename (e.g. dropping
 * `id`) breaks every test fixture at compile time — the regression guard that
 * was missing when the client carried its own divergent `key`-based type.
 */
export function makeThread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 'test',
    label: '',
    workspaceIds: [],
    entities: [],
    lastActivity: 0,
    unreadCount: 0,
    agentStatus: 'idle',
    createdAt: 0,
    archived: false,
    ...overrides
  }
}
