// Backend-agnostic turn parser. Generic enough to handle ContentBlock arrays
// from any backend; backend-specific noise filtering lives in each adapter
// (see `openclaw/parse-turns.ts`).

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
 * Default implementations are no-ops so a vanilla backend gets generic behavior.
 */
export interface ParseTurnsOptions {
  /**
   * Return a system-turn replacement for `text`, or `null` if `text` is not
   * a system-injected (out-of-band) user message. Backends use this to
   * filter their own internal/system markers.
   */
  classifySystemInjected?(text: string): { systemContent: string } | null

  /**
   * Given an injected `text`, return the embedded user message that should be
   * surfaced (if any). Used for cases like OpenClaw's "Sender (untrusted metadata):"
   * appearing after a system prefix.
   */
  extractEmbeddedUser?(text: string): string | null

  /**
   * Strip backend-specific envelope from a user message after generic stripping
   * has already been applied. Default: identity.
   */
  stripUserEnvelope?(text: string): string

  /**
   * Final filter pass — return false to drop a turn from the output. Default
   * keeps everything.
   */
  shouldKeepTurn?(turn: ParsedTurn): boolean

  /** Names of tool calls that should be hidden from work items (e.g. OpenClaw's `sessions_yield`). */
  hiddenToolNames?: Set<string>
}

const DEFAULT_HIDDEN_TOOL_NAMES = new Set<string>()

/**
 * Parse raw backend messages into ParsedTurn[].
 * Generic enough for any backend; supply ParseTurnsOptions for backend-specific noise.
 */
export function parseTurns(messages: any[], options: ParseTurnsOptions = {}): ParsedTurn[] {
  const hiddenTools = options.hiddenToolNames ?? DEFAULT_HIDDEN_TOOL_NAMES
  const classifySystem = options.classifySystemInjected ?? (() => null)
  const extractEmbedded = options.extractEmbeddedUser ?? (() => null)
  const stripEnvelope = options.stripUserEnvelope ?? ((t: string) => t)
  const shouldKeep = options.shouldKeepTurn ?? (() => true)

  const turns: ParsedTurn[] = []
  let currentWork: WorkItem[] = []
  let currentThinking: string[] = []
  let lastUserTurn: ParsedTurn | null = null

  for (const m of messages) {
    const role = m.role ?? ''

    if (role === 'user') {
      if (lastUserTurn) {
        turns.push(lastUserTurn)
      }

      if (currentWork.length > 0) {
        turns.push({
          role: 'assistant',
          content: '',
          timestamp: currentWork[currentWork.length - 1].timestamp ?? 0,
          workItems: currentWork,
          thinkingBlocks: currentThinking
        })
        currentWork = []
        currentThinking = []
      }

      const text = extractText(m.content) ?? ''
      const stripped = stripTimestamp(text)
      const cleaned = stripDirectives(stripped)

      const systemReplacement = classifySystem(text)
      if (systemReplacement) {
        const embeddedUser = extractEmbedded(text)
        if (embeddedUser) {
          const userCleaned = stripDirectives(stripTimestamp(embeddedUser))
          if (userCleaned) {
            lastUserTurn = {
              role: 'user',
              content: userCleaned,
              timestamp: m.timestamp ?? 0,
              workItems: [],
              thinkingBlocks: []
            }
          }
        } else {
          turns.push({
            role: 'system',
            content: systemReplacement.systemContent,
            timestamp: m.timestamp ?? 0,
            workItems: [],
            thinkingBlocks: []
          })
          lastUserTurn = null
        }
        currentWork = []
        currentThinking = []
        continue
      }

      const userText = stripEnvelope(cleaned)
      const finalText = stripTimestamp(userText) || userText

      lastUserTurn = {
        role: 'user',
        content: finalText,
        timestamp: m.timestamp ?? 0,
        workItems: [],
        thinkingBlocks: []
      }
      currentWork = []
      currentThinking = []
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
      const blocks = Array.isArray(m.content) ? m.content : []
      const toolCalls: any[] = []
      let allTextParts: string[] = []

      if (typeof m.content === 'string') {
        allTextParts.push(m.content)
      } else {
        for (const block of blocks) {
          if (block.type === 'toolCall' || block.type === 'tool_use') {
            toolCalls.push(block)
          }
        }
      }

      if (toolCalls.length > 0) {
        if (typeof m.content === 'string') {
          const cleaned = stripDirectives(stripThinkingBlocks(m.content)).trim()
          if (cleaned) {
            currentThinking.push(cleaned)
            currentWork.push({ type: 'thinking', output: cleaned, timestamp: m.timestamp ?? 0 })
          }
        } else {
          for (const block of blocks) {
            if (block.type === 'text' && block.text) {
              const cleaned = stripDirectives(stripThinkingBlocks(block.text)).trim()
              if (cleaned) {
                currentThinking.push(cleaned)
                currentWork.push({ type: 'thinking', output: cleaned, timestamp: m.timestamp ?? 0 })
              }
            } else if (block.type === 'toolCall') {
              if (hiddenTools.has(block.name)) continue
              currentWork.push({
                type: 'tool_call',
                name: block.name ?? 'tool',
                input: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
                toolCallId: block.id,
                timestamp: m.timestamp ?? 0
              })
            } else if (block.type === 'tool_use') {
              if (hiddenTools.has(block.name)) continue
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
        continue
      }

      if (!Array.isArray(m.content) || typeof m.content === 'string') {
        // already in allTextParts
      } else {
        allTextParts = blocks.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text)
      }

      const rawText = allTextParts.join('\n').trim()
      const cleanedText = stripDirectives(stripThinkingBlocks(rawText)).trim()

      if (cleanedText && cleanedText !== 'NO_REPLY' && cleanedText !== 'HEARTBEAT_OK') {
        const turn: ParsedTurn = {
          role: 'assistant',
          content: cleanedText,
          timestamp: m.timestamp ?? 0,
          workItems: currentWork,
          thinkingBlocks: currentThinking
        }
        if (lastUserTurn) {
          turns.push(lastUserTurn)
          lastUserTurn = null
        }
        turns.push(turn)
        currentWork = []
        currentThinking = []
      } else if (cleanedText === '' || cleanedText === 'NO_REPLY' || cleanedText === 'HEARTBEAT_OK') {
        if (lastUserTurn) {
          turns.push(lastUserTurn)
          lastUserTurn = null
        }

        if (m.stopReason === 'error' && m.errorMessage) {
          turns.push({
            role: 'system',
            content: `Error: ${m.errorMessage}`,
            timestamp: m.timestamp ?? 0,
            workItems: [],
            thinkingBlocks: []
          })
        }

        currentWork = []
        currentThinking = []
      }
      continue
    }

    const text = extractText(m.content)
    if (text) {
      const systemReplacement = classifySystem(text)
      turns.push({
        role: 'system',
        content: systemReplacement ? systemReplacement.systemContent : stripDirectives(stripTimestamp(text)),
        timestamp: m.timestamp ?? 0,
        workItems: [],
        thinkingBlocks: []
      })
    }
  }

  if (lastUserTurn) {
    turns.push(lastUserTurn)
  }

  if (currentWork.length > 0) {
    turns.push({
      role: 'assistant',
      content: '',
      timestamp: currentWork[currentWork.length - 1].timestamp ?? 0,
      workItems: currentWork,
      thinkingBlocks: currentThinking
    })
  }

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
