// Context strategy pipeline — runs all strategies in order against a
// message array and applies the resulting prune actions.
//
// The pipeline operates on a shallow copy of the message array.  Each
// strategy receives the original (unmodified) array and produces actions
// referencing indices into that original.  After all strategies run, the
// pipeline merges all actions, resolves conflicts (multiple strategies
// targeting the same index — the most aggressive wins), and applies them
// in a single pass.
//
// This design matches Cozempic's bulk-apply model: strategies can reason
// about the full transcript without seeing each other's intermediate
// mutations.

import type {
  GenericMessage,
  PipelineResult,
  PruneAction,
  StrategyConfig,
  StrategyFn,
  StrategyResult
} from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

// Strategy imports — ordered from most specific to most general.
// Specific strategies (stale-reads, error-retry) run first so their
// targeted logic takes precedence over the broader sweeps.
import { staleReads } from './stale-reads.js'
import { errorRetryCollapse } from './error-retry-collapse.js'
import { toolResultAge } from './tool-result-age.js'
import { documentDedup } from './document-dedup.js'
import { systemReminderDedup } from './system-reminder-dedup.js'
import { megaBlockTrim } from './mega-block-trim.js'

/** The ordered list of strategies in the default pipeline. */
export const DEFAULT_STRATEGIES: StrategyFn[] = [
  staleReads,
  errorRetryCollapse,
  toolResultAge,
  documentDedup,
  systemReminderDedup,
  megaBlockTrim // safety net — always last
]

/** Merge actions from multiple strategies targeting the same message index.
 *  When multiple strategies touch the same index:
 *    - 'remove' beats 'replace' (more aggressive wins)
 *    - Among replaces, the one with the smallest prunedChars wins
 *  Returns a deduplicated action map: index → winning action. */
function mergeActions(allActions: PruneAction[]): Map<number, PruneAction> {
  const merged = new Map<number, PruneAction>()

  for (const action of allActions) {
    const existing = merged.get(action.index)
    if (!existing) {
      merged.set(action.index, action)
      continue
    }
    // Remove always wins
    if (action.action === 'remove' && existing.action !== 'remove') {
      merged.set(action.index, action)
      continue
    }
    // Among replaces, prefer the smaller result (more savings)
    if (action.action === 'replace' && existing.action === 'replace' && action.prunedChars < existing.prunedChars) {
      merged.set(action.index, action)
    }
  }

  return merged
}

/** Apply merged actions to a message array in place.  Removes happen
 *  first (from highest index to lowest to preserve indices), then
 *  replaces. Returns the number of messages removed and replaced. */
function applyActions(
  messages: GenericMessage[],
  actionMap: Map<number, PruneAction>
): { removed: number; replaced: number } {
  let removed = 0
  let replaced = 0

  // Collect removes — sort descending so splices don't shift indices
  const removes: number[] = []
  const replaces: Array<{ index: number; content: string }> = []

  for (const [index, action] of actionMap) {
    if (action.action === 'remove') {
      removes.push(index)
    } else if (action.action === 'replace' && action.replacement !== undefined) {
      replaces.push({ index, content: action.replacement })
    }
  }

  // Apply replaces first (they don't change indices)
  for (const { index, content } of replaces) {
    if (index >= 0 && index < messages.length) {
      messages[index] = { ...messages[index], content }
      replaced++
    }
  }

  // Apply removes from highest to lowest index
  removes.sort((a, b) => b - a)
  for (const index of removes) {
    if (index >= 0 && index < messages.length) {
      messages.splice(index, 1)
      removed++
    }
  }

  return { removed, replaced }
}

/** Run the full context strategy pipeline against a message array.
 *  Mutates `messages` in place and returns aggregate statistics.
 *
 *  @param messages  The conversation transcript — mutated in place.
 *  @param config    Optional strategy configuration overrides.
 *  @param strategies  Optional custom strategy list (defaults to all).
 */
export function runContextStrategies(
  messages: GenericMessage[],
  config?: Partial<StrategyConfig>,
  strategies?: StrategyFn[]
): PipelineResult {
  const start = performance.now()
  const fullConfig: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG, ...config }
  const strategyList = strategies ?? DEFAULT_STRATEGIES

  // Take a snapshot of original chars before any mutations
  const totalOriginalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)

  // Run each strategy against the ORIGINAL message array
  const results: StrategyResult[] = []
  const allActions: PruneAction[] = []

  for (const strategy of strategyList) {
    const result = strategy(messages, fullConfig)
    results.push(result)
    allActions.push(...result.actions)
  }

  // Merge and apply
  const actionMap = mergeActions(allActions)
  const { removed, replaced } = applyActions(messages, actionMap)

  const totalPrunedChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const durationMs = performance.now() - start

  return {
    strategies: results,
    totalOriginalChars,
    totalPrunedChars: totalOriginalChars - totalPrunedChars,
    totalRemoved: removed,
    totalReplaced: replaced,
    durationMs
  }
}
