// Canonical thread data shape — the single serializable contract shared by
// the server (registry, routes, scheduler) and the client (stores, UI).
//
// Threads are identified by a bare UUID `id` end-to-end (post-UUID refactor);
// `label` is the mutable display name. There is deliberately NO `key` field —
// the old human-key model is gone, and keeping a single source of truth here
// means a stale `thread.key` access anywhere is a compile error.

import type { AgentStatus } from './agent-backend.js'

export type EntityType = 'branch' | 'issue' | 'pr' | 'file'

/**
 * Reference to a git-provider entity attached to a thread. `orgId` identifies
 * which org/provider hosts the entity (for issue/PR/branch routing); it does
 * NOT determine the thread's membrane — that's `ThreadInfo.membraneId`.
 */
export interface EntityBinding {
  orgId: string
  projectId: string
  entityType: EntityType
  entityRef: string
}

export interface ThreadInfo {
  /**
   * Opaque, immutable UUID — primary key everywhere in the codebase.
   * URLs, registry rows, scheduler payloads, chat session mappings, etc.
   * all reference this. Set once at creation; never reassigned.
   */
  id: string
  /**
   * Human-readable display name. Mutable. Not unique. May contain anything.
   * The UI renders this; no part of the routing or storage layer should
   * branch on it.
   */
  label: string
  /**
   * Primary membrane (social/privacy context) that owns this thread.
   * Undefined = unassigned (rare — only for legacy threads whose membrane
   * couldn't be inferred during migration).
   */
  membraneId?: string
  /**
   * Code contexts (orgIds from @sovereign/orgs) attached to this thread.
   * A thread may span multiple repos; the first entry is the conventional
   * default for UI resolution. Empty array = no code context.
   */
  workspaceIds: string[]
  entities: EntityBinding[]
  /** Context window size in tokens. When set above the default (200k),
   *  the backend enables the 1M-context beta. Unset = model default. */
  contextWindow?: number
  /** Role this thread plays in the presence system.
   *    - `'internal'`  Agent's stream-of-consciousness. Receives ambient
   *                    inbound (voice, AD4M, watched-thread digests).
   *                    Carries PRESENCE.md + PRESENCE_MEMORY.md. Has the
   *                    `presence_reply_*` + `presence_watch_*` tools.
   *                    NOT push-notified.
   *    - `'gateway'`   User's text-chat surface. Normal Claude Code thread
   *                    with its own session. Has the `presence_internal_*`
   *                    tools to forward to / read internal state.
   *  At most one thread carries each role. See `plans/presence-thread-spec.md`. */
  presence?: 'internal' | 'gateway'
  lastActivity: number
  unreadCount: number
  agentStatus: AgentStatus
  createdAt: number
  archived: boolean
}
