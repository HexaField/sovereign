// stale-reads — stub file reads superseded by later edits.
//
// When a file gets read and then later edited/written, the read result
// carries stale data — the model should re-read rather than rely on it.
// This strategy scans tool-call pairs (tool_calls on assistant messages
// matched by tool_call_id on tool-result messages) to find Read results
// whose file path appears in a later Edit/Write call, and replaces the
// stale content with a short stub.
//
// Adapted from Cozempic's stale-reads strategy (0.5-2% savings).

import type { GenericMessage, PruneAction, StrategyConfig, StrategyResult } from './types.js'
import { DEFAULT_STRATEGY_CONFIG } from './types.js'

interface FileEvent {
  index: number
  kind: 'read' | 'edit'
  filePath: string
}

export function staleReads(messages: readonly GenericMessage[], config: StrategyConfig): StrategyResult {
  const keepRecent = config.keepRecentMessages ?? DEFAULT_STRATEGY_CONFIG.keepRecentMessages
  const totalChars = messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)
  const actions: PruneAction[] = []
  let totalPruned = 0

  const protectedFrom = Math.max(0, messages.length - keepRecent)

  // Build file event timeline from tool calls
  const events: FileEvent[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls) continue
    for (const call of msg.tool_calls) {
      const fn = call.function
      if (!fn?.name) continue
      let filePath: string | null = null
      try {
        const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
        filePath = ((args as Record<string, unknown>)?.file_path as string) ?? null
      } catch {
        continue
      }
      if (!filePath) continue
      const name = fn.name
      if (name === 'Read' || name === 'read') {
        events.push({ index: i, kind: 'read', filePath })
      } else if (['Edit', 'edit', 'Write', 'write'].includes(name)) {
        events.push({ index: i, kind: 'edit', filePath })
      }
    }
  }

  // For each read, check if the same file has a later edit
  const staleReadToolCallIds = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'read') continue
    const hasLaterEdit = events.some((e) => e.kind === 'edit' && e.filePath === event.filePath && e.index > event.index)
    if (!hasLaterEdit) continue

    // Find the tool_call_id for this read
    const msg = messages[event.index]
    for (const call of msg.tool_calls ?? []) {
      const fn = call.function
      if (!fn?.name || !['Read', 'read'].includes(fn.name)) continue
      try {
        const args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments
        if ((args as Record<string, unknown>)?.file_path === event.filePath) {
          staleReadToolCallIds.add(call.id)
        }
      } catch {
        continue
      }
    }
  }

  // Find and prune the tool result messages for stale reads
  for (let i = 0; i < protectedFrom; i++) {
    const msg = messages[i]
    if (msg.role !== 'tool') continue
    if (!msg.tool_call_id || !staleReadToolCallIds.has(msg.tool_call_id)) continue
    const content = msg.content
    if (typeof content !== 'string' || content.length < 500) continue

    const stub = '[stale read — file was later edited, content pruned]'
    const saved = content.length - stub.length
    if (saved > 0) {
      actions.push({
        index: i,
        action: 'replace',
        reason: 'stale-read (file later edited)',
        originalChars: content.length,
        prunedChars: stub.length,
        replacement: stub
      })
      totalPruned += saved
    }
  }

  return {
    strategyName: 'stale-reads',
    actions,
    originalChars: totalChars,
    prunedChars: totalPruned,
    messagesAffected: actions.length,
    messagesRemoved: 0,
    messagesReplaced: actions.length,
    summary: `Pruned ${actions.length} stale file read results (${(totalPruned / 1024).toFixed(0)}KB saved)`
  }
}
