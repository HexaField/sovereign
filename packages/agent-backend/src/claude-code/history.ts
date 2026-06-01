// Claude Code session JSONL reader. The on-disk format is one JSON object per
// line, each with `type: 'user' | 'assistant' | 'system'` and a nested
// `message` object whose shape matches Anthropic's message format. We
// normalize each line into the shape `parseTurns` consumes, run it through
// the generic shared parser, then hand every turn to `classifyClaudeCodeTurn`
// — the single place Claude Code envelope grammars (cron, task-notification,
// invoke, compaction, error) are decoded.

import fs from 'node:fs'
import path from 'node:path'
import type { ParsedTurn } from '@sovereign/core'
import { parseTurns as parseTurnsGeneric, stripTimestamp } from '@sovereign/primitives'
import { readAllMessages as sharedReadAll, readRecentMessages as sharedReadRecent } from '@sovereign/primitives'
import { classifyClaudeCodeTurn } from './classify.js'

/**
 * Normalize one JSONL entry from a Claude Code session file into the message
 * shape the shared parser expects. Returns null for entries that shouldn't
 * surface as turns (summary entries, custom-title entries, etc.).
 */
/** Detect SDK-injected slash-command synthetics that look like user turns
 *  but are actually internal Claude Code chatter the user never typed. */
function isSlashCommandSynthetic(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('<command-args>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<local-command-stderr>')
  )
}

export function normalizeClaudeCodeEntry(entry: any): any | null {
  if (!entry || typeof entry !== 'object') return null

  const tsRaw = entry.timestamp ?? entry.message?.timestamp
  const timestamp = typeof tsRaw === 'number' ? tsRaw : typeof tsRaw === 'string' ? Date.parse(tsRaw) || 0 : 0

  if (entry.type === 'user' && entry.message) {
    // SDK flags for entries that exist in the JSONL for resume-correctness but
    // MUST NOT render as user turns: the post-compaction rehydration message,
    // any entry tagged transcript-only-visible. Honour both.
    if (entry.isCompactSummary === true) return null
    if (entry.isVisibleInTranscriptOnly === true) return null
    // Slash-command artefacts (`/compact`, future `/something` invocations)
    // arrive as user turns whose content is a `<command-name>…` envelope.
    // Pure Claude Code internal chatter — drop.
    const raw = entry.message.content
    if (typeof raw === 'string' && isSlashCommandSynthetic(raw)) return null
    return {
      role: 'user',
      content: raw,
      timestamp
    }
  }
  if (entry.type === 'assistant' && entry.message) {
    return {
      role: 'assistant',
      content: entry.message.content,
      timestamp,
      stopReason: entry.message.stop_reason
    }
  }
  if (entry.type === 'system' && (entry.subtype === 'compact_boundary' || entry.subtype === 'compaction')) {
    // The SDK writes compaction metadata under `compactMetadata` (camelCase)
    // with `preTokens` / `postTokens`. Tolerate `compact_metadata` /
    // `pre_tokens` / `post_tokens` for forward-compat with older SDK builds.
    const meta = entry.compactMetadata ?? entry.compact_metadata ?? {}
    const pre =
      typeof meta.preTokens === 'number' ? meta.preTokens : typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null
    const post =
      typeof meta.postTokens === 'number'
        ? meta.postTokens
        : typeof meta.post_tokens === 'number'
          ? meta.post_tokens
          : null
    const trigger = meta.trigger ?? 'auto'
    const parts: string[] = ['⚙️ Compacted']
    if (pre != null && post != null) {
      parts.push(`(${pre.toLocaleString()} → ${post.toLocaleString()} tokens, ${trigger})`)
    } else if (trigger) {
      parts.push(`(${trigger})`)
    }
    return {
      role: 'system',
      content: parts.join(' '),
      timestamp
    }
  }
  // summary / title / other system metadata — skip.
  return null
}

/** Apply Claude Code-specific classification on top of the shared parser. */
export function parseClaudeCodeTurns(messages: any[]): ParsedTurn[] {
  const turns = parseTurnsGeneric(messages, {
    shouldKeepTurn: (turn) => {
      const text = (turn.content ?? '').trim()
      if (!text) return true
      // Drop legacy bare cron chips with no body — they carry no signal once
      // the envelope is decoded by the classifier.
      if (text === '[Cron]' || text === 'Cron') return false
      return true
    }
  })
  return turns.map(classifyClaudeCodeTurn)
}

/** Read all messages from a Claude Code session JSONL file. */
export function readAllClaudeCodeMessages(filePath: string): any[] {
  return sharedReadAll(filePath, normalizeClaudeCodeEntry)
}

/** Read the tail of a Claude Code session JSONL file (recent N messages). */
export function readRecentClaudeCodeMessages(filePath: string, limit = 200): { messages: any[]; hasMore: boolean } {
  return sharedReadRecent(filePath, limit, normalizeClaudeCodeEntry)
}

/** Resolve the on-disk session file path for a (projectsDir, sessionId) pair. */
export function findSessionFile(projectsDir: string, sessionId: string): string | null {
  const candidate = path.join(projectsDir, `${sessionId}.jsonl`)
  return fs.existsSync(candidate) ? candidate : null
}

/** Compute aggregate usage from a session file's `result` entries. */
export function computeUsageFromFile(filePath: string): {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
} {
  const out = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const usage = entry?.message?.usage
        if (usage) {
          out.inputTokens += usage.input_tokens ?? 0
          out.outputTokens += usage.output_tokens ?? 0
          out.cacheRead += usage.cache_read_input_tokens ?? 0
          out.cacheWrite += usage.cache_creation_input_tokens ?? 0
        }
        const cost = entry?.total_cost_usd ?? entry?.message?.total_cost_usd
        if (typeof cost === 'number') out.costUsd += cost
      } catch {
        /* malformed line */
      }
    }
  } catch {
    /* file missing */
  }
  return out
}

// Expose for tests/utilities; not used by parser internally.
export { stripTimestamp }
