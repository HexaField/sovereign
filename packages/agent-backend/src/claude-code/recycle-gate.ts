// When an auto-recycle may run. Pruning frees only old tool output and
// thinking, so a session of real conversation stays over the threshold after
// it; ungated, it recycled before every message for ~2 %.
//
// - Floor: after a recycle, wait for the context to grow `regrowPercent` of
//   the window past what the recycle left.
// - Exhausted: a recycle that freed under `minReclaimPercent` turns
//   auto-recycle off until a compaction shrinks the session.

export interface RecycleGateInput {
  /** Tokens in context at the last API call. */
  filled: number
  /** The session's context window. */
  maxTokens: number
  thresholdPercent: number
  /** Tokens the last recycle left; undefined before the first recycle or after a compaction. */
  floor?: number
  regrowPercent: number
  exhausted?: boolean
}

export function recycleWanted(g: RecycleGateInput): boolean {
  if (g.maxTokens <= 0 || g.filled <= 0 || g.exhausted) return false
  if ((g.filled / g.maxTokens) * 100 < g.thresholdPercent) return false
  if (g.floor !== undefined && g.filled < g.floor + (g.regrowPercent / 100) * g.maxTokens) return false
  return true
}

/** True when a recycle freed too little for pruning to be worth repeating. */
export function recycleExhausted(preTokens: number, postTokens: number, minReclaimPercent: number): boolean {
  return preTokens > 0 && ((preTokens - postTokens) / preTokens) * 100 < minReclaimPercent
}
