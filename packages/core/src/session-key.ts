// Thread identifier helpers.
//
// Sovereign now identifies threads by bare UUIDs end-to-end. The legacy
// `agent:main:thread:<x>` / `agent:main:subagent:<x>` / `agent:main:main`
// compound-key scheme (OpenClaw inheritance) has been retired.
//
// This module remains as a compatibility seam during the migration window:
// `deriveSessionKey` is now an identity function plus a coercion for legacy
// inputs (it strips any lingering `agent:…` prefix). Once every caller is
// confirmed to pass bare ids, the wrappers can be deleted.

/**
 * Coerce a thread reference to a bare UUID. Accepts:
 *   - a UUID                            → returned unchanged
 *   - a legacy compound key             → bare segment extracted
 *   - `''` / falsy                      → `''`
 *
 * Use at every boundary that ingests an external id (route param, MCP arg,
 * scheduler payload). Internal code should already be holding bare UUIDs.
 */
export function unwrapThreadId(value: string): string {
  if (!value) return ''
  if (value.startsWith('agent:main:thread:')) return value.slice('agent:main:thread:'.length)
  if (value.startsWith('agent:main:subagent:')) return value.slice('agent:main:subagent:'.length)
  // Legacy alias for the (now-removed) main thread. Migration replaced this
  // record with a regular UUID; anything still saying `agent:main:main` is
  // pre-migration data that should not be reached.
  if (value === 'agent:main:main') return 'main'
  return value
}

/**
 * Identity bridge — kept so existing callers compile through the
 * migration. `threadId` should already be a bare UUID; the function
 * gracefully strips any leftover legacy prefix.
 *
 * @deprecated Use the bare `threadId` directly. This will be removed once
 * all consumers have been audited.
 */
export function deriveSessionKey(threadIdOrLegacyKey: string): string {
  return unwrapThreadId(threadIdOrLegacyKey)
}

/**
 * Minimal contract for callers (e.g. threads/routes) that need to look up a
 * thread's bound backend session id without depending on the full
 * ChatModule.
 */
export interface ThreadSessionBinding {
  getSessionKeyForThread(threadId: string): string | undefined
}
