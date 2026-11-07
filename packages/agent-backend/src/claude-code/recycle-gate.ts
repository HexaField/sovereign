// When an auto-recycle may run. Pruning frees only old tool output and
// thinking, so a session of real conversation stays over the threshold after
// it; ungated, it recycled before every message for ~2 %.
//
// - Floor: after a recycle, wait for the context to grow `regrowPercent` of
//   the window past what the recycle left.
//   A recycle that freed little sets a high floor, so the next one waits for
//   new tool output to accumulate rather than stopping for good.
// - Cold cache: a session idle longer than the prompt-cache TTL rewrites its
//   whole prompt on the next call anyway, so a prune then costs no extra cache
//   write: it only shrinks that rewrite and every later read. The lower
//   `coldThresholdPercent` applies.

export interface RecycleGateInput {
  /** Tokens in context at the last API call. */
  filled: number
  /** The session's context window. */
  maxTokens: number
  thresholdPercent: number
  /** Tokens the last recycle left; undefined before the first recycle or after a compaction. */
  floor?: number
  regrowPercent: number
  /** Time since the session's last API call; with `cacheTtlMs` and `coldThresholdPercent`, a cold cache lowers the threshold. */
  idleMs?: number
  cacheTtlMs?: number
  coldThresholdPercent?: number
}

export function recycleWanted(g: RecycleGateInput): boolean {
  if (g.maxTokens <= 0 || g.filled <= 0) return false
  const cold = g.idleMs !== undefined && g.cacheTtlMs !== undefined && g.idleMs >= g.cacheTtlMs
  const threshold = cold && g.coldThresholdPercent !== undefined ? g.coldThresholdPercent : g.thresholdPercent
  if ((g.filled / g.maxTokens) * 100 < threshold) return false
  if (g.floor !== undefined && g.filled < g.floor + (g.regrowPercent / 100) * g.maxTokens) return false
  return true
}
