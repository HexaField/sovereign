// system-reminder-dedup — deduplicate <system-reminder> tags within
// tool results and assistant messages.
//
// The Claude Code SDK injects <system-reminder> blocks into tool results
// — the same block repeats identically across many turns.  This strategy
// hashes each unique reminder and replaces duplicates with an empty string,
// collapsing the resulting blank lines.
//
// Adapted from Cozempic's system-reminder-dedup strategy (0.1-3% savings).

import { createHash } from 'node:crypto'
import type { GenericMessage, PruneAction, StrategyConfig, StrategyResult } from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

const REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

export function systemReminderDedup(messages: readonly GenericMessage[], config: StrategyConfig): StrategyResult {
  const keepRecent = config.keepRecentMessages ?? DEFAULT_STRATEGY_CONFIG.keepRecentMessages
  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const actions: PruneAction[] = []
  let totalPruned = 0

  const seenHashes = new Set<string>()
  const protectedFrom = Math.max(0, messages.length - keepRecent)

  for (let i = 0; i < protectedFrom; i++) {
    const content = messages[i].content
    if (typeof content !== 'string') continue

    const reminders = content.match(REMINDER_PATTERN)
    if (!reminders || reminders.length === 0) continue

    let newContent = content
    let changed = false

    for (const reminder of reminders) {
      const hash = md5(reminder)
      if (seenHashes.has(hash)) {
        // Duplicate — remove this occurrence
        newContent = newContent.replace(reminder, '')
        changed = true
      } else {
        seenHashes.add(hash)
      }
    }

    if (changed) {
      // Collapse excess blank lines left by removal
      newContent = newContent.replace(/\n{3,}/g, '\n\n').trim()
      const saved = content.length - newContent.length
      if (saved > 0) {
        actions.push({
          index: i,
          action: 'replace',
          reason: 'system-reminder-dedup',
          originalChars: content.length,
          prunedChars: newContent.length,
          replacement: newContent
        })
        totalPruned += saved
      }
    }
  }

  return {
    strategyName: 'system-reminder-dedup',
    actions,
    originalChars: totalChars,
    prunedChars: totalPruned,
    messagesAffected: actions.length,
    messagesRemoved: 0,
    messagesReplaced: actions.length,
    summary: `Deduped system-reminders in ${actions.length} messages (${seenHashes.size} unique)`
  }
}
