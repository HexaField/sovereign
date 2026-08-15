// mega-block-trim — safety net that truncates any message content
// exceeding a configurable maximum (default 32KB).
//
// Runs last in the pipeline as a catch-all — every other strategy should
// handle their domain first, but if something slips through (an enormous
// Bash output, a serialised JSON blob), this caps it.
//
// Adapted from Cozempic's mega-block-trim strategy.

import type { GenericMessage, PruneAction, StrategyConfig, StrategyResult } from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

export function megaBlockTrim(messages: readonly GenericMessage[], config: StrategyConfig): StrategyResult {
  const maxChars = config.megaBlockMaxChars ?? DEFAULT_STRATEGY_CONFIG.megaBlockMaxChars
  const keepRecent = config.keepRecentMessages ?? DEFAULT_STRATEGY_CONFIG.keepRecentMessages

  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const actions: PruneAction[] = []
  let totalPruned = 0

  const protectedFrom = Math.max(0, messages.length - keepRecent)

  for (let i = 0; i < protectedFrom; i++) {
    const msg = messages[i]
    // Don't trim system messages (compaction summaries)
    if (msg.role === 'system') continue
    const content = msg.content
    if (typeof content !== 'string') continue
    if (content.length <= maxChars) continue

    const half = Math.floor(maxChars / 2)
    const trimmedCount = content.length - maxChars
    const truncated =
      content.slice(0, half) +
      `\n\n[... ${trimmedCount} chars trimmed by context strategy ...]\n\n` +
      content.slice(-half)

    const saved = content.length - truncated.length
    if (saved > 0) {
      actions.push({
        index: i,
        action: 'replace',
        reason: `mega-block-trim (${(content.length / 1024).toFixed(0)}KB → ${(truncated.length / 1024).toFixed(0)}KB)`,
        originalChars: content.length,
        prunedChars: truncated.length,
        replacement: truncated
      })
      totalPruned += saved
    }
  }

  return {
    strategyName: 'mega-block-trim',
    actions,
    originalChars: totalChars,
    prunedChars: totalPruned,
    messagesAffected: actions.length,
    messagesRemoved: 0,
    messagesReplaced: actions.length,
    summary: `Trimmed ${actions.length} mega blocks (>${(maxChars / 1024).toFixed(0)}KB)`
  }
}
