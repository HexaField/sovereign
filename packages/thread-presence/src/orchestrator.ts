// Orchestrator — glue between chat-turn completion events, the presence
// tracker, the mute store, and the push manager.
//
// Pure logic, no transport. The only side effects it performs are:
//   - threadManager.markUnreadIncrement / clearUnread
//   - push.sendAll(payload)
//
// All wiring (bus listeners, WS hooks) is set up by `wirePresenceOrchestrator`
// in the server bootstrap; the pieces below are exported for unit testing
// without the rest of the system.

import type { EventBus } from '@sovereign/core'

export interface OrchestratorDeps {
  bus: EventBus
  presence: { isThreadFocused(threadId: string): boolean }
  muteStore: { isMuted(threadId: string): boolean }
  threadManager: {
    get(id: string):
      | {
          id: string
          label: string
          unreadCount: number
          presence?: 'internal' | 'gateway'
        }
      | undefined
    markUnreadIncrement(id: string): number | undefined
    clearUnread(id: string): boolean
  }
  push: { sendAll(payload: unknown): Promise<void> }
  /** Default body when the turn payload has no text — overridable for i18n. */
  defaultBody?: string
}

export interface PushPayload {
  type: 'thread.turn' | 'thread.clear'
  threadId: string
  title?: string
  body?: string
  tag: string
  unreadCount?: number
  timestamp: string
}

export function pushTagForThread(threadId: string): string {
  return `thread-${threadId}`
}

function extractTurnText(turn: unknown): string {
  if (!turn || typeof turn !== 'object') return ''
  const t = turn as Record<string, unknown>
  // ChatTurn shape: { role, content: string | block[], ... }
  if (typeof t.content === 'string') return t.content
  if (Array.isArray(t.content)) {
    for (const block of t.content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>
        if (typeof b.text === 'string') return b.text
      }
    }
  }
  if (typeof t.text === 'string') return t.text
  return ''
}

/** Truncate an assistant message body to a notification-friendly length. */
function truncateForPush(text: string, max = 140): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= max) return trimmed
  return trimmed.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Handle a single `chat.turn.completed` event. Returns a description of what
 * was done — useful for tests and tracing. Suppresses push + badge when the
 * thread is focused on any device OR muted.
 */
export async function handleTurnCompleted(
  deps: OrchestratorDeps,
  payload: { threadId: string; turn?: unknown }
): Promise<{ pushed: boolean; bumped: boolean; reason?: string }> {
  const { threadId, turn } = payload
  if (!threadId) return { pushed: false, bumped: false, reason: 'no-threadId' }
  const thread = deps.threadManager.get(threadId)
  if (!thread) return { pushed: false, bumped: false, reason: 'unknown-thread' }
  // Only act on the agent (assistant) finishing — synthetic user turns also
  // fire `chat.turn.completed` and we'd otherwise double-count + notify on
  // our own outgoing messages.
  const role = (turn as { role?: string } | undefined)?.role
  if (role && role !== 'assistant') {
    return { pushed: false, bumped: false, reason: 'non-assistant-turn' }
  }
  if (deps.muteStore.isMuted(threadId)) {
    return { pushed: false, bumped: false, reason: 'muted' }
  }
  // The internal presence thread is stream-of-consciousness — its assistant
  // turns are never auto-pushed. External delivery happens only via explicit
  // presence_reply_* tools. The gateway thread, by contrast, IS a normal
  // user-facing chat surface and gets normal push notifications. See
  // plans/presence-thread-spec.md (R4).
  if (thread.presence === 'internal') {
    return { pushed: false, bumped: false, reason: 'presence-internal' }
  }
  if (deps.presence.isThreadFocused(threadId)) {
    return { pushed: false, bumped: false, reason: 'focused' }
  }
  const newCount = deps.threadManager.markUnreadIncrement(threadId) ?? 0
  const body = truncateForPush(extractTurnText(turn)) || deps.defaultBody || 'Agent finished a turn.'
  const payloadOut: PushPayload = {
    type: 'thread.turn',
    threadId,
    title: thread.label || 'Sovereign',
    body,
    tag: pushTagForThread(threadId),
    unreadCount: newCount,
    timestamp: new Date().toISOString()
  }
  await deps.push.sendAll(payloadOut)
  return { pushed: true, bumped: true }
}

/**
 * Clear unread + ask every subscriber to dismiss matching-tag notifications.
 * Idempotent: a redundant call on a zero-unread thread sends no push.
 */
export async function handleThreadIteration(
  deps: OrchestratorDeps,
  threadId: string
): Promise<{ cleared: boolean; dismissed: boolean }> {
  if (!threadId) return { cleared: false, dismissed: false }
  const thread = deps.threadManager.get(threadId)
  if (!thread) return { cleared: false, dismissed: false }
  const had = (thread.unreadCount ?? 0) > 0
  const cleared = deps.threadManager.clearUnread(threadId)
  if (!had) return { cleared: false, dismissed: false }
  const payloadOut: PushPayload = {
    type: 'thread.clear',
    threadId,
    tag: pushTagForThread(threadId),
    timestamp: new Date().toISOString()
  }
  await deps.push.sendAll(payloadOut)
  return { cleared, dismissed: true }
}

export interface WireOrchestratorOpts extends OrchestratorDeps {}

/**
 * Subscribe to bus events. Returns a disposer.
 *
 * Triggers:
 *   - `chat.turn.completed`  → handleTurnCompleted
 *   - `chat.message.sent`    → handleThreadIteration (user just iterated)
 *   - `thread.focused`       → handleThreadIteration (focus from WS)
 *
 * `thread.focused` is emitted by the presence WS layer (see bootstrap).
 */
export function wirePresenceOrchestrator(deps: WireOrchestratorOpts): { destroy: () => void } {
  const unsubs: Array<() => void> = []

  unsubs.push(
    deps.bus.on('chat.turn.completed', (event) => {
      const p = event.payload as { threadId?: string; turn?: unknown }
      if (!p?.threadId) return
      void handleTurnCompleted(deps, { threadId: p.threadId, turn: p.turn })
    })
  )

  unsubs.push(
    deps.bus.on('chat.message.sent', (event) => {
      const p = event.payload as { threadId?: string }
      if (!p?.threadId) return
      void handleThreadIteration(deps, p.threadId)
    })
  )

  unsubs.push(
    deps.bus.on('thread.focused', (event) => {
      const p = event.payload as { threadId?: string }
      if (!p?.threadId) return
      void handleThreadIteration(deps, p.threadId)
    })
  )

  return {
    destroy() {
      for (const u of unsubs) u()
    }
  }
}
