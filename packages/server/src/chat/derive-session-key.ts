// Derive a canonical Sovereign session key for a logical thread key.
//
// The canonical form is `agent:main:thread:<x>` (matching the historic
// OpenClaw convention). For Pi and Claude Code backends, the canonical key
// is registry-mapped to a backend-internal id (a Pi UUID, a Claude Code
// session UUID) at session-create time; the canonical key itself remains
// backend-agnostic.
//
// `backendKind` is accepted for forward compatibility — callers can pass it
// to make their intent explicit, but Phase 0 derives the same canonical key
// regardless of backend.
import type { AgentBackendKind } from '@sovereign/core'

export function deriveSessionKey(threadKey: string, _backendKind?: AgentBackendKind): string {
  if (!threadKey) return ''
  // Already a full session key — don't double-prefix
  if (threadKey.startsWith('agent:')) return threadKey
  if (threadKey === 'main') return 'agent:main:main'
  return `agent:main:thread:${threadKey.toLowerCase()}`
}
