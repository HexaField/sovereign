// document-dedup — hash-based deduplication of large content blocks.
//
// Repeated content wastes context budget.  Common sources:
//   - CLAUDE.md / AGENTS.md injected into multiple tool results
//   - System-reminder tags repeated across turns
//   - Identical file reads (same file read, same content)
//
// First occurrence stays.  Subsequent occurrences get replaced with a
// short stub referencing the first.
//
// Adapted from Cozempic's document-dedup strategy (0-44% savings).

import { createHash } from 'node:crypto'
import type { GenericMessage, PruneAction, StrategyConfig, StrategyResult } from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

export function documentDedup(messages: readonly GenericMessage[], config: StrategyConfig): StrategyResult {
  const minChars = config.dedupMinChars ?? DEFAULT_STRATEGY_CONFIG.dedupMinChars
  const keepRecent = config.keepRecentMessages ?? DEFAULT_STRATEGY_CONFIG.keepRecentMessages

  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const actions: PruneAction[] = []
  let totalPruned = 0

  // Track hashes: hash → index of first occurrence
  const seen = new Map<string, number>()
  const protectedFrom = Math.max(0, messages.length - keepRecent)

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content
    if (typeof content !== 'string') continue
    if (content.length < minChars) continue

    const hash = md5(content)
    const firstSeen = seen.get(hash)

    if (firstSeen === undefined) {
      seen.set(hash, i)
      continue
    }

    // Duplicate found — only prune if outside the protected window
    if (i >= protectedFrom) continue

    const preview = content.slice(0, 80).replace(/\n/g, ' ')
    const stub = `[duplicate content — first seen at message ${firstSeen}: ${preview}...]`
    const saved = content.length - stub.length
    if (saved > 0) {
      actions.push({
        index: i,
        action: 'replace',
        reason: `document-dedup (hash=${hash.slice(0, 8)})`,
        originalChars: content.length,
        prunedChars: stub.length,
        replacement: stub
      })
      totalPruned += saved
    }
  }

  return {
    strategyName: 'document-dedup',
    actions,
    originalChars: totalChars,
    prunedChars: totalPruned,
    messagesAffected: actions.length,
    messagesRemoved: 0,
    messagesReplaced: actions.length,
    summary: `Deduped ${actions.length} large content blocks (${(totalPruned / 1024).toFixed(0)}KB saved)`
  }
}
