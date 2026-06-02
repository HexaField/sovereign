// Threads — Types

import type { AgentStatus } from '@sovereign/core'

export type EntityType = 'branch' | 'issue' | 'pr' | 'file'

/**
 * Reference to a git-provider entity attached to a thread. The `orgId` here
 * is intentional and unrelated to the (removed) `ThreadInfo.orgId`: it
 * identifies which org/provider hosts the entity so the issues / PR / branch
 * routing layer knows where to look. It does NOT determine the thread's
 * membrane — that's the job of `ThreadInfo.membraneId`.
 */
export interface EntityBinding {
  orgId: string
  projectId: string
  entityType: EntityType
  entityRef: string
}

export interface ThreadInfo {
  key: string
  /**
   * Primary membrane (social/privacy context) that owns this thread.
   * See @sovereign/membranes. Undefined = unassigned (rare — only happens
   * for legacy threads whose membrane couldn't be inferred during migration).
   */
  membraneId?: string
  /**
   * Code contexts (orgIds from @sovereign/orgs) attached to this thread.
   * A thread may span multiple repos; the first entry is the conventional
   * default for UI resolution. Empty array = no code context (global /
   * pure-thinking thread).
   */
  workspaceIds: string[]
  entities: EntityBinding[]
  label?: string
  lastActivity: number
  unreadCount: number
  agentStatus: AgentStatus
  createdAt: number
  archived: boolean
}

export interface ThreadEvent {
  threadKey: string
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
  create(opts: { label?: string; entities?: EntityBinding[]; membraneId?: string; workspaceIds?: string[] }): ThreadInfo
  get(key: string): ThreadInfo | undefined
  update(key: string, patch: { label?: string; membraneId?: string; workspaceIds?: string[] }): ThreadInfo | undefined
  list(filter?: ThreadFilter): ThreadInfo[]
  delete(key: string): boolean
  addEntity(key: string, entity: EntityBinding): ThreadInfo | undefined
  removeEntity(key: string, entityType: EntityType, entityRef: string): ThreadInfo | undefined
  getEntities(key: string): EntityBinding[]
  getThreadsForEntity(entity: EntityBinding): ThreadInfo[]
  addEvent(key: string, event: ThreadEvent): void
  touch(key: string): void
  getEvents(key: string, opts?: { limit?: number; offset?: number; since?: number }): ThreadEvent[]
}
