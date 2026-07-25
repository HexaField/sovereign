// Pure drain-loop over the active-sessions liveness snapshot. Used by the
// server's graceful-shutdown path to wait for in-flight LLM turns to finish
// before actually tearing the process down.
//
// A session is "draining" while its snapshot shows the agent is
// `working`/`thinking` AND no `pendingToolAwait` marker is set. Tool-await
// sessions are explicitly exempt — they can only complete via a user
// submission, and the resume orchestrator's tool-await short-circuit
// restores them cleanly on the next boot (the SDK re-fires the tool_use,
// the hook re-registers).

import type { ActiveSessions } from './active-sessions.js'

export interface DrainOptions {
  activeSessions: ActiveSessions
  /** Cap on total wait. */
  timeoutMs: number
  /** Poll interval. Defaults to 500ms. */
  pollMs?: number
  /** Optional sleep hook for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Optional monotonic clock hook for tests. */
  now?: () => number
  /** Optional line-based logger for progress. */
  log?: (msg: string) => void
}

export interface DrainResult {
  /** How long the drain took in ms (wall clock). */
  drainedMs: number
  /** Sessions still working when we gave up (0 = clean drain). */
  leftWorking: number
  /** Whether we hit the timeout cap. */
  timedOut: boolean
}

export function countDraining(activeSessions: ActiveSessions): number {
  let n = 0
  for (const e of activeSessions.list()) {
    if (e.pendingToolAwait) continue
    if (e.agentStatus === 'working' || e.agentStatus === 'thinking') n++
  }
  return n
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function drainActiveSessions(opts: DrainOptions): Promise<DrainResult> {
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 500
  const log = opts.log
  const start = now()
  const initial = countDraining(opts.activeSessions)
  if (initial > 0) log?.(`draining ${initial} in-flight session(s) — waiting up to ${opts.timeoutMs}ms`)
  let lastLoggedRemaining = initial
  while (now() - start < opts.timeoutMs) {
    const remaining = countDraining(opts.activeSessions)
    if (remaining === 0) break
    if (remaining !== lastLoggedRemaining) {
      log?.(`${remaining} session(s) still working`)
      lastLoggedRemaining = remaining
    }
    await sleep(pollMs)
  }
  const leftWorking = countDraining(opts.activeSessions)
  const drainedMs = now() - start
  const timedOut = leftWorking > 0
  if (timedOut) {
    log?.(
      `timeout after ${drainedMs}ms — ${leftWorking} session(s) still working; resume orchestrator will handle them on next boot`
    )
  } else if (initial > 0) {
    log?.(`drained cleanly in ${drainedMs}ms`)
  }
  return { drainedMs, leftWorking, timedOut }
}
