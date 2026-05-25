// Canonical session key derivation. Pure function with no module deps — kept
// in core so threads/chat/agent-backend can all derive keys without depending
// on each other.

import type { AgentBackendKind } from './agent-backend.js'

/**
 * Derive the canonical Sovereign session key for a logical thread key.
 *
 * The canonical form is `agent:main:thread:<x>` (matching the historic
 * OpenClaw convention). For Pi and Claude Code backends, the canonical key
 * is registry-mapped to a backend-internal id at session-create time.
 *
 * `backendKind` is accepted for forward compatibility — callers can pass it
 * to make their intent explicit, but the canonical key is the same across
 * backends.
 */
export function deriveSessionKey(threadKey: string, _backendKind?: AgentBackendKind): string {
  if (!threadKey) return ''
  if (threadKey.startsWith('agent:')) return threadKey
  if (threadKey === 'main') return 'agent:main:main'
  return `agent:main:thread:${threadKey.toLowerCase()}`
}

/**
 * Minimal contract for callers (e.g. threads/routes) that need to look up a
 * thread's bound session key without depending on the full ChatModule.
 */
export interface ThreadSessionBinding {
  getSessionKeyForThread(threadKey: string): string | undefined
}
