// Context strategy types — generic message pruning for both local-llm and
// Claude Code backends.  Each strategy scans a conversation transcript and
// produces PruneActions (remove or replace) that the pipeline applies in bulk.
//
// Modelled after Cozempic's strategy/action architecture but adapted for
// in-memory message arrays rather than JSONL file rewriting.

/** A single message in the conversation transcript.  The pipeline treats
 *  messages as opaque objects with a `role` and optional `content` — the
 *  exact shape varies by backend (OpenAI ChatMessage for local-llm,
 *  Anthropic JSONL entries for Claude Code). */
export interface GenericMessage {
  role: string
  content?: string | null
  /** OpenAI-format tool result metadata. */
  name?: string
  tool_call_id?: string
  /** OpenAI-format tool calls on assistant messages. */
  tool_calls?: Array<{
    id: string
    function?: { name?: string; arguments?: string }
  }>
  /** Timestamp (epoch ms) — present on local-llm ChatMessage. */
  timestamp?: number
  /** Allow additional fields from either backend. */
  [key: string]: unknown
}

/** An action produced by a strategy — either remove the message entirely
 *  or replace its content. */
export interface PruneAction {
  /** Index into the original message array. */
  index: number
  action: 'remove' | 'replace'
  /** Human-readable reason for the prune (logged / metricated). */
  reason: string
  /** Original byte size of the message's content. */
  originalChars: number
  /** Chars after replacement (0 for remove). */
  prunedChars: number
  /** Replacement content — required when action === 'replace'. */
  replacement?: string
}

/** The result of running one strategy across the transcript. */
export interface StrategyResult {
  strategyName: string
  actions: PruneAction[]
  originalChars: number
  prunedChars: number
  messagesAffected: number
  messagesRemoved: number
  messagesReplaced: number
  summary: string
}

/** A strategy function — takes the message array and optional config,
 *  returns actions to apply. Must NOT mutate the input array. */
export type StrategyFn = (messages: readonly GenericMessage[], config: StrategyConfig) => StrategyResult

/** Pipeline configuration — strategy-specific knobs. */
export interface StrategyConfig {
  /** tool-result-age: turns before a tool result enters the "mid" tier. */
  toolResultMidAge?: number
  /** tool-result-age: turns before a tool result enters the "old" tier. */
  toolResultOldAge?: number
  /** document-dedup: minimum content length (chars) to participate. */
  dedupMinChars?: number
  /** mega-block-trim: max content chars before truncation. */
  megaBlockMaxChars?: number
  /** tool-output-trim: max content chars for a single tool result. */
  toolOutputMaxChars?: number
  /** tool-output-trim: max lines for a single tool result. */
  toolOutputMaxLines?: number
  /** Number of most-recent messages exempt from age-based strategies. */
  keepRecentMessages?: number
}

/** Default config values matching Cozempic's tuned thresholds. */
export const DEFAULT_STRATEGY_CONFIG: Required<StrategyConfig> = {
  toolResultMidAge: 15,
  toolResultOldAge: 40,
  dedupMinChars: 1024,
  megaBlockMaxChars: 32_000,
  toolOutputMaxChars: 8192,
  toolOutputMaxLines: 100,
  keepRecentMessages: 10
}

/** Aggregate stats from running the full pipeline. */
export interface PipelineResult {
  strategies: StrategyResult[]
  totalOriginalChars: number
  totalPrunedChars: number
  totalRemoved: number
  totalReplaced: number
  durationMs: number
}
