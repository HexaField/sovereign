// Cozempic stdout parser — extracts strategy metrics from cozempic's
// human-readable treat output. Expected format:
//
//   Before      61.0K tokens   11.63MB  3,803 messages
//   After       31.8K tokens    1.33MB  220 messages
//   Saved       29.3K tokens (47.9%)  10.30MB freed
//
//   What changed:
//     compact-summary-collapse      10.20MB  3583 msgs
//     tool-use-result-strip          77.4KB    18 msgs

import type { ContextStrategyMetric } from '../metrics.js'

export type ParsedCozempicMetric = Omit<ContextStrategyMetric, 'ts' | 'sessionKey' | 'backendKind' | 'model'>

/** Parse a size string like "10.20MB", "77.4KB", "5.4KB" into chars. */
export function parseSizeToChars(sizeStr: string): number {
  const match = sizeStr.match(/([\d.]+)\s*(MB|KB|B)/i)
  if (!match) return 0
  const val = parseFloat(match[1])
  const unit = match[2].toUpperCase()
  if (unit === 'MB') return Math.round(val * 1024 * 1024)
  if (unit === 'KB') return Math.round(val * 1024)
  return Math.round(val)
}

/** Parse cozempic's treat output into a context strategy metric payload.
 *  Returns null when the output lacks the expected structure. */
export function parseCozempicOutput(stdout: string): ParsedCozempicMetric | null {
  const lines = stdout.split('\n').map((l) => l.trim())

  // Parse "Before" line for original chars
  const beforeLine = lines.find((l) => l.startsWith('Before'))
  if (!beforeLine) return null
  const beforeSize = beforeLine.match(/([\d.]+[MKGB]+B)/i)
  const originalChars = beforeSize ? parseSizeToChars(beforeSize[1]) : 0

  // Parse "Saved" line for pruned chars
  const savedLine = lines.find((l) => l.startsWith('Saved'))
  const savedSize = savedLine?.match(/([\d.]+[MKGB]+B)\s+freed/i)
  const prunedChars = savedSize ? parseSizeToChars(savedSize[1]) : 0

  // Parse "What changed:" block for per-strategy breakdown
  const strategies: ParsedCozempicMetric['strategies'] = []
  let inChanged = false
  let totalRemoved = 0
  const totalReplaced = 0

  for (const line of lines) {
    if (line.startsWith('What changed:')) {
      inChanged = true
      continue
    }
    if (!inChanged) continue
    // Empty line or "Note:" ends the block
    if (!line || line.startsWith('Note:') || line.startsWith('Dry run')) break

    // Pattern: "strategy-name      10.20MB  3583 msgs"
    const stratMatch = line.match(/^(\S+)\s+([\d.]+\s*[MKGB]*B)\s+(\d+)\s+msgs?$/)
    if (stratMatch) {
      const msgs = parseInt(stratMatch[3], 10)
      strategies.push({
        name: stratMatch[1],
        charsSaved: parseSizeToChars(stratMatch[2]),
        messagesAffected: msgs,
        messagesRemoved: msgs,
        messagesReplaced: 0
      })
      totalRemoved += msgs
    }
  }

  return {
    strategies,
    originalChars,
    prunedChars,
    messagesRemoved: totalRemoved,
    messagesReplaced: totalReplaced,
    durationMs: 0 // Cozempic doesn't report duration in stdout
  }
}
