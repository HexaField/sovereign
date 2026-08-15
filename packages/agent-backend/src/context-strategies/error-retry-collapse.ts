// error-retry-collapse — collapse identical tool-call → error → retry
// sequences into a single attempt.
//
// When a tool fails and the model retries with identical arguments, the
// intermediate error/retry pairs carry no value — only the final attempt
// matters.  This strategy detects such sequences and removes the
// intermediate rounds.
//
// Adapted from Cozempic's error-retry-collapse strategy (0-5% savings).

import { createHash } from 'node:crypto'
import type { GenericMessage, PruneAction, StrategyConfig, StrategyResult } from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

interface ToolCallInfo {
  index: number
  name: string
  argsHash: string
}

interface ErrorInfo {
  index: number
}

export function errorRetryCollapse(messages: readonly GenericMessage[], config: StrategyConfig): StrategyResult {
  const keepRecent = config.keepRecentMessages ?? DEFAULT_STRATEGY_CONFIG.keepRecentMessages
  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const actions: PruneAction[] = []
  let totalPruned = 0

  const protectedFrom = Math.max(0, messages.length - keepRecent)

  // Build a sequence of tool calls and errors
  const sequence: Array<{ type: 'call'; info: ToolCallInfo } | { type: 'error'; info: ErrorInfo }> = []

  for (let i = 0; i < protectedFrom; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        const fn = call.function
        if (!fn?.name) continue
        const argsStr = fn.arguments ?? '{}'
        sequence.push({
          type: 'call',
          info: { index: i, name: fn.name, argsHash: md5(argsStr) }
        })
      }
    }
    // Detect error results — tool results with error indicators
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      const content = msg.content
      // Common error patterns: starts with "Error:", "error:", stack trace,
      // or contains typical error markers
      const looksLikeError =
        content.startsWith('Error:') ||
        content.startsWith('error:') ||
        content.includes('ENOENT') ||
        content.includes('EACCES') ||
        content.includes('Permission denied') ||
        content.includes('command not found') ||
        content.includes('No such file') ||
        content.includes('Traceback (most recent call last)')
      if (looksLikeError) {
        sequence.push({ type: 'error', info: { index: i } })
      }
    }
  }

  // Scan for call → error → identical-call patterns
  const indicesToRemove = new Set<number>()
  let s = 0
  while (s < sequence.length - 2) {
    const first = sequence[s]
    if (first.type !== 'call') {
      s++
      continue
    }

    // Look for: call A → error → call A (same name + argsHash) → ...
    const retries: Array<{ errorIdx: number; retryIdx: number }> = []
    let j = s + 1
    while (j < sequence.length - 1) {
      const maybeError = sequence[j]
      if (maybeError.type !== 'error') break
      const maybeRetry = sequence[j + 1]
      if (maybeRetry.type !== 'call') break
      if (
        maybeRetry.info.name === first.info.name &&
        (maybeRetry.info as ToolCallInfo).argsHash === first.info.argsHash
      ) {
        retries.push({
          errorIdx: maybeError.info.index,
          retryIdx: (maybeRetry.info as ToolCallInfo).index
        })
        j += 2
        continue
      }
      break
    }

    if (retries.length > 0) {
      // Remove all intermediate error+retry pairs except the last retry
      for (const { errorIdx, retryIdx } of retries.slice(0, -1)) {
        indicesToRemove.add(errorIdx)
        indicesToRemove.add(retryIdx)
      }
      // Also remove the last error (but keep the final retry — that succeeded or failed definitively)
      const lastRetry = retries[retries.length - 1]
      indicesToRemove.add(lastRetry.errorIdx)
    }
    s = retries.length > 0 ? j : s + 1
  }

  for (const idx of indicesToRemove) {
    const content = messages[idx].content
    const chars = typeof content === 'string' ? content.length : 0
    actions.push({
      index: idx,
      action: 'remove',
      reason: 'error-retry-collapse (intermediate retry)',
      originalChars: chars,
      prunedChars: 0
    })
    totalPruned += chars
  }

  // Sort by index for deterministic application
  actions.sort((a, b) => a.index - b.index)

  return {
    strategyName: 'error-retry-collapse',
    actions,
    originalChars: totalChars,
    prunedChars: totalPruned,
    messagesAffected: actions.length,
    messagesRemoved: actions.length,
    messagesReplaced: 0,
    summary: `Collapsed ${actions.length} error retry messages (${(totalPruned / 1024).toFixed(0)}KB saved)`
  }
}
