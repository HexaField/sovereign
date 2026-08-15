// Context strategies — Cozempic-inspired progressive pruning pipeline
// for both local-llm and Claude Code backends.
//
// Usage:
//   import { runContextStrategies } from './context-strategies/index.js'
//   const result = runContextStrategies(messages, { toolResultMidAge: 10 })
//   // messages is mutated in place — result has stats

export { runContextStrategies, DEFAULT_STRATEGIES } from './pipeline.js'
export { toolResultAge } from './tool-result-age.js'
export { documentDedup } from './document-dedup.js'
export { systemReminderDedup } from './system-reminder-dedup.js'
export { staleReads } from './stale-reads.js'
export { errorRetryCollapse } from './error-retry-collapse.js'
export { megaBlockTrim } from './mega-block-trim.js'
export type {
  GenericMessage,
  PruneAction,
  StrategyResult,
  StrategyFn,
  StrategyConfig,
  PipelineResult
} from './types.js'
export { DEFAULT_STRATEGY_CONFIG } from './types.js'
