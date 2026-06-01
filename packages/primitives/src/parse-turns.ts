// Backend-agnostic turn parser. Generic enough to handle ContentBlock arrays
// from any backend; backend-specific noise filtering lives in each adapter.

import type { ParsedTurn, WorkItem } from '@sovereign/core'
import { stripThinkingBlocks } from './thinking.js'

/** Extract text from a message's content (string | ContentBlock[]). */
export function extractText(msg: unknown): string | null {
  if (!msg) return null
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg))
    return (msg as any[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
  if (typeof msg === 'object' && 'content' in (msg as any)) return extractText((msg as any).content)
  if (typeof msg === 'object' && (msg as any).type === 'text') return (msg as any).text ?? null
  return null
}

/** Convert base64 to detected MIME type. */
export function detectImageMime(base64: string): string {
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('R0lGO')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

/** Extract content including image blocks as HTML img tags — for tool result output. */
export function extractContentOutput(msg: unknown): string | null {
  if (!msg) return null
  if (typeof msg === 'string') return msg
  if (Array.isArray(msg)) {
    const parts: string[] = []
    for (const b of msg as any[]) {
      if (b.type === 'text' && b.text) {
        parts.push(b.text)
      } else if (b.type === 'image' && b.data) {
        const mime = b.mimeType || detectImageMime(b.data)
        parts.push(
          `<img src="data:${mime};base64,${b.data}" class="tool-screenshot" style="max-width:100%;height:auto;border-radius:4px;display:block;margin:4px 0;" />`
        )
      }
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  if (typeof msg === 'object' && 'content' in (msg as any)) return extractContentOutput((msg as any).content)
  return null
}

/** Strip a generic gateway-injected timestamp prefix. */
export function stripTimestamp(text: string): string {
  return text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[^\]]*\]\s*/, '')
}

/** Strip backend-agnostic directive tags ([[reply_to_current]] etc.). */
export function stripDirectives(text: string): string {
  return text.replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '').trim()
}

/**
 * Optional hooks supplied by a backend-specific parser.
 *
 * The generic parser stays envelope-agnostic — it merges assistant rounds,
 * pairs tool calls with results, and emits one `ParsedTurn` per user/assistant
 * boundary. Backend-specific envelope decoding (Claude Code cron prefix,
 * `<task-notification>`, etc.) belongs in the adapter's classifier and runs
 * as a post-pass on the returned turns.
 */
export interface ParseTurnsOptions {
  /**
   * Final filter pass — return false to drop a turn from the output. Default
   * keeps everything.
   */
  shouldKeepTurn?(turn: ParsedTurn): boolean
}

/**
 * Parse raw backend messages into ParsedTurn[].
 * Generic enough for any backend; supply ParseTurnsOptions for backend-specific noise.
 */
export function parseTurns(messages: any[], options: ParseTurnsOptions = {}): ParsedTurn[] {
  const shouldKeep = options.shouldKeepTurn ?? (() => true)

  const turns: ParsedTurn[] = []
  let currentWork: WorkItem[] = []
  let currentThinking: string[] = []
  // Accumulator for the agent's narration text across a round. Claude Code
  // emits the agent's reply in chunks: intermediate text ("Let me check X"),
  // followed by more tool calls, followed by the final answer. Everything
  // between two REAL user messages is one logical assistant turn.
  let currentAssistantTexts: string[] = []
  let lastAssistantTs: number = 0
  let lastUserTurn: ParsedTurn | null = null

  function flushAssistantRound(): void {
    if (currentWork.length === 0 && currentAssistantTexts.length === 0) return
    const content = currentAssistantTexts.join('\n\n').trim()
    // Skip the round entirely if it only contains sentinel-only text and no
    // work. (Non-sentinel content with work-only is fine — empty bubble.)
    if (currentWork.length === 0 && (content === 'NO_REPLY' || content === 'HEARTBEAT_OK')) {
      currentAssistantTexts = []
      return
    }
    turns.push({
      role: 'assistant',
      content,
      timestamp: lastAssistantTs || (currentWork[currentWork.length - 1]?.timestamp ?? 0),
      workItems: currentWork,
      thinkingBlocks: currentThinking
    })
    currentWork = []
    currentThinking = []
    currentAssistantTexts = []
    lastAssistantTs = 0
  }

  function pushAssistantBlocks(m: any): void {
    lastAssistantTs = m.timestamp ?? lastAssistantTs
    if (typeof m.content === 'string') {
      const cleaned = stripDirectives(stripThinkingBlocks(m.content)).trim()
      if (cleaned) currentAssistantTexts.push(cleaned)
      return
    }
    const blocks = Array.isArray(m.content) ? m.content : []
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        const cleaned = stripDirectives(stripThinkingBlocks(block.text)).trim()
        if (cleaned) currentAssistantTexts.push(cleaned)
      } else if (block.type === 'thinking') {
        const raw = (block.thinking ?? block.text ?? '').toString().trim()
        if (raw) {
          currentThinking.push(raw)
          currentWork.push({ type: 'thinking', output: raw, timestamp: m.timestamp ?? 0 })
        }
      } else if (block.type === 'toolCall') {
        currentWork.push({
          type: 'tool_call',
          name: block.name ?? 'tool',
          input: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
          toolCallId: block.id,
          timestamp: m.timestamp ?? 0
        })
      } else if (block.type === 'tool_use') {
        currentWork.push({
          type: 'tool_call',
          name: block.name ?? 'tool',
          input: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          toolCallId: block.id,
          timestamp: m.timestamp ?? 0
        })
      }
    }
  }

  for (const m of messages) {
    const role = m.role ?? ''

    if (role === 'user') {
      // Tool-result envelope: when an assistant has called a tool, the SDK
      // emits a user-role message whose content is an array of `tool_result`
      // blocks (no text). It is NOT a real user turn — it's the agent's own
      // tool result feedback. Accumulate into currentWork and continue so the
      // surrounding round of [thinking → tool_use → tool_result → text]
      // coalesces into a SINGLE assistant turn.
      if (Array.isArray(m.content)) {
        const blocks = m.content as any[]
        const hasText = blocks.some((b) => b.type === 'text' && b.text)
        const toolResults = blocks.filter((b) => b.type === 'tool_result')
        if (toolResults.length > 0 && !hasText) {
          for (const b of toolResults) {
            currentWork.push({
              type: 'tool_result',
              output: extractContentOutput(b.content) ?? undefined,
              toolCallId: b.tool_use_id,
              timestamp: m.timestamp ?? 0
            })
          }
          continue
        }
      }

      // Real user message — flush the previous round.
      if (lastUserTurn) {
        turns.push(lastUserTurn)
      }
      flushAssistantRound()

      const text = extractText(m.content) ?? ''
      const cleaned = stripDirectives(stripTimestamp(text))

      lastUserTurn = {
        role: 'user',
        content: cleaned,
        timestamp: m.timestamp ?? 0,
        workItems: [],
        thinkingBlocks: []
      }
      continue
    }

    if (role === 'toolResult') {
      currentWork.push({
        type: 'tool_result',
        name: m.toolName ?? 'tool',
        output: extractContentOutput(m.content) ?? undefined,
        toolCallId: m.toolCallId,
        timestamp: m.timestamp ?? 0
      })
      continue
    }

    if (role === 'assistant') {
      // The user-turn boundary is the only thing that ends an assistant
      // round. Any text, thinking, or tool_use in this message just adds to
      // the running accumulators. A round is later emitted as ONE turn whose
      // `content` is the joined narration and whose `workItems` are all the
      // tool calls + thinking in chronological order.
      pushAssistantBlocks(m)

      // Stop-reason: error → emit a system turn after flushing.
      if (m.stopReason === 'error' && m.errorMessage) {
        if (lastUserTurn) {
          turns.push(lastUserTurn)
          lastUserTurn = null
        }
        flushAssistantRound()
        turns.push({
          role: 'system',
          content: `Error: ${m.errorMessage}`,
          timestamp: m.timestamp ?? 0,
          workItems: [],
          thinkingBlocks: []
        })
      }
      continue
    }

    const text = extractText(m.content)
    if (text) {
      turns.push({
        role: 'system',
        content: stripDirectives(stripTimestamp(text)),
        timestamp: m.timestamp ?? 0,
        workItems: [],
        thinkingBlocks: []
      })
    }
  }

  if (lastUserTurn) {
    turns.push(lastUserTurn)
  }
  flushAssistantRound()

  const filtered = turns.filter((t) => {
    const text = (t.content ?? '').trim()
    if (!text) return true

    if (text === 'NO_REPLY' || text === 'ANNOUNCE_SKIP' || text === 'REPLY_SKIP' || text === 'HEARTBEAT_OK')
      return false

    return shouldKeep(t)
  })

  const afterConsecutive = filtered.filter((t, i) => {
    if (i === 0) return true
    if (t.role === 'user') return true
    const prev = filtered[i - 1]
    return t.content !== prev.content || t.role !== prev.role
  })

  const DEDUP_WINDOW_MS = 10_000
  const seenUser = new Map<string, number>()
  return afterConsecutive.filter((t) => {
    if (t.role !== 'user') return true
    const content = t.content.trim()
    if (!content) return true
    const prevTs = seenUser.get(content)
    const ts = t.timestamp || 0
    if (prevTs !== undefined && Math.abs(ts - prevTs) < DEDUP_WINDOW_MS) {
      return false
    }
    seenUser.set(content, ts)
    return true
  })
}
