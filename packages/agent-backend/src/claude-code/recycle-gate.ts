// When an auto-recycle may run. Pruning only frees old tool output and
// thinking; a session made of real conversation stays above the threshold
// after it. Without a gate, such a session recycled before every message:
// an interrupt, a full transcript archive and a cozempic pass, for ~2 %.
//
// - Floor: after a recycle, wait until the context grows `regrowPercent` of
//   the window past what the recycle left.
// - Exhausted: a recycle that freed under `minReclaimPercent` of the context
//   shows pruning cannot help; auto-recycle stays off until Claude Code's own
//   compaction (a summary) shrinks the session.

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
