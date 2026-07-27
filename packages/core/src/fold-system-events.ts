// Fold "framing" system turns (compaction chips, hook lifecycle output) into
// the neighbouring assistant turn's workItems as `system_event` rows.
//
// Why: these events describe *what happened around the assistant round* — the
// CLI compacted the context; a SessionStart hook fired the cozempic guard —
// so they belong beside the turn's tool calls in the collapsible work list,
// not as standalone bubbles between turns. Attaching to the preceding
// assistant turn's tail lets the existing WorkSection UI render them without
// a new component surface, and keeps the transcript flow visually uninterrupted.
//
// Attach target, in priority order:
//   1. The most recent already-kept assistant turn — the "post-round" case
//      (compaction after the reply, PostCompact hook chain).
//   2. The next kept turn if it's assistant — the "pre-round" case
//      (SessionStart hook running before the first assistant reply). We do
//      this by buffering the framing turns and flushing them onto the next
//      assistant turn we emit.
//   3. If the transcript has no assistant turn at all (e.g. new thread whose
//      first message is still queued), keep the framing turn as its own bubble
//      so the info isn't lost.

import type { ParsedTurn, WorkItem } from './agent-backend.js'

/** TurnKind variants that should be folded into workItems rather than rendered as standalone turns. */
const FOLDED_VARIANTS = new Set(['compaction', 'hook-output', 'session-resumed'])

/**
 * Prefix of the continuation prompt the resume orchestrator injects after a
 * restart (see `resumeActiveSessions`). The marker is Sovereign-generated, not
 * backend-specific, so the pattern lives here in core — the client's live fold
 * matches on it directly (the synthetic `chat.turn` arrives before any backend
 * classifier has run), while backend adapters tag it as `session-resumed` for
 * history replay.
 */
const SESSION_RESUMED_RE = /^\[Resumed after server restart\b/

/** True iff `content` is the resume orchestrator's continuation marker. */
export function isSessionResumedMarker(content: string | undefined): boolean {
  return !!content && SESSION_RESUMED_RE.test(content.trim())
}

function isFoldable(turn: ParsedTurn): boolean {
  if (turn.role !== 'system') return false
  if (turn.kind && FOLDED_VARIANTS.has(turn.kind.variant)) return true
  // Live path: the synthetic turn is broadcast straight from the chat module
  // with no `kind`, so match the raw marker too.
  return isSessionResumedMarker(turn.content)
}

/**
 * Convert a foldable system turn to a `system_event` work item preserving the
 * original label / body / payload so the client can render icon + detail.
 */
export function foldableToWorkItem(turn: ParsedTurn): WorkItem {
  const resumed = !turn.kind && isSessionResumedMarker(turn.content)
  const variant = turn.kind?.variant ?? (resumed ? 'session-resumed' : undefined)
  const label = turn.kind?.label ?? (resumed ? 'Resumed after restart' : 'System')
  const icon = variant === 'compaction' ? 'compaction' : variant === 'session-resumed' ? 'resumed' : 'hook'
  return {
    type: 'system_event',
    name: label,
    output: turn.content,
    icon,
    timestamp: turn.timestamp
  }
}

/**
 * Rewrite a turn list so all foldable system turns are attached to a
 * neighbouring assistant turn's workItems. Pure — no mutation of the input.
 */
export function foldSystemEventsIntoWork(turns: ParsedTurn[]): ParsedTurn[] {
  const out: ParsedTurn[] = []
  // Buffer the raw ParsedTurns (not WorkItems) so we can push them back as
  // standalone entries if no assistant ever appears to anchor them.
  let pending: ParsedTurn[] = []

  for (const turn of turns) {
    if (isFoldable(turn)) {
      // Prefer attaching to the most recent assistant turn we've already kept
      // (post-round framing: compaction after the reply, PostCompact hooks).
      let attached = false
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === 'assistant') {
          out[i] = { ...out[i], workItems: [...(out[i].workItems ?? []), foldableToWorkItem(turn)] }
          attached = true
          break
        }
      }
      if (!attached) {
        // No preceding assistant turn yet — buffer and flush onto the next
        // assistant turn we emit (pre-round framing: SessionStart hooks).
        pending.push(turn)
      }
      continue
    }

    if (pending.length > 0 && turn.role === 'assistant') {
      const merged = pending.map(foldableToWorkItem)
      out.push({ ...turn, workItems: [...merged, ...(turn.workItems ?? [])] })
      pending = []
      continue
    }
    out.push(turn)
  }

  // Anything still pending has no assistant turn to land on — keep the raw
  // system turns at the end so the info isn't silently dropped. This is a
  // last-resort fallback; in practice a session always has assistant turns.
  return pending.length > 0 ? [...out, ...pending] : out
}

/**
 * Single-turn variant for the live SSE path. Given an incoming turn and the
 * current transcript, either attach the incoming as a work item onto the last
 * assistant turn (returning `{ absorbed: true, turns: <updated list> }`), or
 * signal the caller to append it as a new turn (`{ absorbed: false }`).
 */
export function absorbFoldableTurn(
  incoming: ParsedTurn,
  current: ParsedTurn[]
): { absorbed: true; turns: ParsedTurn[] } | { absorbed: false } {
  if (!isFoldable(incoming)) return { absorbed: false }
  const wi = foldableToWorkItem(incoming)
  for (let i = current.length - 1; i >= 0; i--) {
    if (current[i].role === 'assistant') {
      const updated = current.slice()
      updated[i] = { ...updated[i], workItems: [...(updated[i].workItems ?? []), wi] }
      return { absorbed: true, turns: updated }
    }
  }
  return { absorbed: false }
}
