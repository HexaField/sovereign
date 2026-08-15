// tool-result-age — three-tier age-based tool result compaction.
//
// Tool results decay in value exponentially.  A file read from 50 turns
// ago carries near-zero value — the file has almost certainly changed.
// The model can re-read if needed.
//
// Tiers:
//   Recent  (0 to midAge turns):  untouched
//   Mid-age (midAge to oldAge):   JSON minification, whitespace collapse
//   Old     (oldAge+):            replace content with compact stub
//
// Adapted from Cozempic's tool-result-age strategy (10-40% savings).

import type { GenericMessage, PruneAction, StrategyConfig, StrategyResult } from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

/** Count user-role messages that carry actual user text (not tool results). */
function countUserTurns(messages: readonly GenericMessage[]): number {
  let count = 0
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    // OpenAI tool results also use role:'user' with tool_result content —
    // skip those.  A genuine user prompt has string content with no
    // tool_call_id.
    if (msg.tool_call_id) continue
    count++
  }
  return count
}

/** Build a per-message "turns ago" index.  For each message position,
 *  returns how many user turns precede the total. */
function buildTurnIndex(messages: readonly GenericMessage[]): number[] {
  const totalTurns = countUserTurns(messages)
  let turnsSoFar = 0
  const turnsAgo: number[] = []
  for (const msg of messages) {
    if (msg.role === 'user' && !msg.tool_call_id) {
      turnsSoFar++
    }
    turnsAgo.push(totalTurns - turnsSoFar)
  }
  return turnsAgo
}

/** Minify mid-age content: collapse JSON whitespace, shorten
 *  multiline text without losing structure. */
function minifyContent(content: string): string {
  // Try JSON minification first
  try {
    const parsed = JSON.parse(content)
    const minified = JSON.stringify(parsed)
    // Only use if meaningful savings (> 15%)
    if (minified.length < content.length * 0.85) return minified
  } catch {
    // Not JSON — fall through
  }

  // Collapse runs of blank lines
  return content.replace(/\n{3,}/g, '\n\n')
}

/** Build a compact stub for an old tool result. */
function buildStub(content: string, toolName?: string): string {
  const lineCount = content.split('\n').length
  const charCount = content.length
  const parts = ['[pruned']
  if (toolName) parts.push(`: ${toolName}`)
  parts.push(` — ${lineCount} lines, ${(charCount / 1024).toFixed(1)}KB]`)
  return parts.join('')
}

export function toolResultAge(messages: readonly GenericMessage[], config: StrategyConfig): StrategyResult {
  const midAge = config.toolResultMidAge ?? DEFAULT_STRATEGY_CONFIG.toolResultMidAge
  const oldAge = config.toolResultOldAge ?? DEFAULT_STRATEGY_CONFIG.toolResultOldAge
  const keepRecent = config.keepRecentMessages ?? DEFAULT_STRATEGY_CONFIG.keepRecentMessages

  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const turnsAgo = buildTurnIndex(messages)
  const actions: PruneAction[] = []
  let totalPruned = 0

  // Don't touch the most recent N messages regardless of age
  const protectedFrom = Math.max(0, messages.length - keepRecent)

  for (let i = 0; i < protectedFrom; i++) {
    const msg = messages[i]
    // Only prune tool-result messages
    if (msg.role !== 'tool') continue
    const content = msg.content
    if (typeof content !== 'string' || content.length < 100) continue

    const age = turnsAgo[i]
    if (age < midAge) continue

    if (age >= oldAge) {
      // OLD: replace with compact stub
      const stub = buildStub(content, msg.name ?? undefined)
      const saved = content.length - stub.length
      if (saved > 0) {
        actions.push({
          index: i,
          action: 'replace',
          reason: `tool-result-age (${age} turns ago, old)`,
          originalChars: content.length,
          prunedChars: stub.length,
          replacement: stub
        })
        totalPruned += saved
      }
    } else {
      // MID-AGE: minify content
      const minified = minifyContent(content)
      const saved = content.length - minified.length
      if (saved > 0) {
        actions.push({
          index: i,
          action: 'replace',
          reason: `tool-result-age (${age} turns ago, mid)`,
          originalChars: content.length,
          prunedChars: minified.length,
          replacement: minified
        })
        totalPruned += saved
      }
    }
  }

  return {
    strategyName: 'tool-result-age',
    actions,
    originalChars: totalChars,
    prunedChars: totalPruned,
    messagesAffected: actions.length,
    messagesRemoved: 0,
    messagesReplaced: actions.length,
    summary: `Compacted ${actions.length} old tool results (${(totalPruned / 1024).toFixed(0)}KB saved)`
  }
}
