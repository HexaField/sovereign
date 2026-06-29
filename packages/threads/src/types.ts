// Threads — Types
//
// The canonical serializable thread shape (`ThreadInfo`, `EntityBinding`,
// `EntityType`) lives in @sovereign/core so the client and server share ONE
// definition — a stale `thread.key` access then fails to compile everywhere.
// Re-exported here for back-compat with the many `@sovereign/threads` importers.

import type { EntityType, EntityBinding, ThreadInfo } from '@sovereign/core'

export type { EntityType, EntityBinding, ThreadInfo } from '@sovereign/core'

export interface ThreadEvent {
  threadId: string
  event: unknown
  entityBinding: EntityBinding
  timestamp: number
}

export interface ThreadFilter {
  membraneId?: string
  /**
   * Match threads attached to a given workspace (orgId). Matches if:
   *   - `workspaceIds` includes the value, OR
   *   - any `entities[].orgId` matches, OR
   *   - the special value `_global` AND the thread has no workspaces /
   *     no entity bindings (i.e. lives in the global bucket).
   *
   * Replaces the old `orgId` filter; the wire API at `/api/threads?orgId=X`
   * is still accepted and translated to this field.
   */
  workspaceId?: string
  projectId?: string
  entityType?: EntityType
  active?: boolean
  archived?: boolean
}

export interface ForwardedMessage {
  originalContent: string
  originalRole: 'user' | 'assistant' | 'system'
  originalTimestamp: number
  sourceThread: string
  sourceThreadLabel: string
  commentary?: string
  attachments?: string[]
}

export interface ThreadManager {
  /**
   * Create a new thread. `label` is required (no more "the key IS the label").
   * Returns the freshly minted record including its UUID `id`.
   */
  create(opts: {
    label: string
    entities?: EntityBinding[]
    membraneId?: string
    workspaceIds?: string[]
    contextWindow?: number
  }): ThreadInfo
  /** Get by UUID. */
  get(id: string): ThreadInfo | undefined
  /** Get by display label. Returns the first match; labels are not unique. */
  getByLabel(label: string): ThreadInfo | undefined
  /**
   * Resolve a "thread reference" from any input the user / agent / URL might
   * provide: UUID (preferred) → exact label → undefined. Used at every
   * route boundary so we can accept either form without parsing kludges
   * scattered through callers.
   */
  resolve(idOrLabel: string): ThreadInfo | undefined
  update(
    id: string,
    patch: { label?: string; membraneId?: string; workspaceIds?: string[]; contextWindow?: number }
  ): ThreadInfo | undefined
  list(filter?: ThreadFilter): ThreadInfo[]
  delete(id: string): boolean
  addEntity(id: string, entity: EntityBinding): ThreadInfo | undefined
  removeEntity(id: string, entityType: EntityType, entityRef: string): ThreadInfo | undefined
  getEntities(id: string): EntityBinding[]
  getThreadsForEntity(entity: EntityBinding): ThreadInfo[]
  addEvent(id: string, event: ThreadEvent): void
  touch(id: string): void
  getEvents(id: string, opts?: { limit?: number; offset?: number; since?: number }): ThreadEvent[]
  /** Increment a thread's `unreadCount`, persist, and broadcast `thread.updated`.
   *  Returns the new count, or `undefined` if the thread doesn't exist. */
  markUnreadIncrement(id: string): number | undefined
  /** Reset `unreadCount` to 0. Returns true iff the count actually changed. */
  clearUnread(id: string): boolean
}
