// Parse raw gateway ChatMessage[] into ParsedTurn[]
// Adapted from voice-ui's parseTurns logic

import type { ParsedTurn, WorkItem } from '@sovereign/core'
import { stripThinkingBlocks } from './thinking.js'

/** Extract text from gateway message content (string | ContentBlock[]). */
function extractText(msg: unknown): string | null {
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

/** Strip gateway-injected timestamp prefix */
function stripTimestamp(text: string): string {
  return text.replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[^\]]*\]\s*/, '')
}

/** Strip directive tags */
function stripDirectives(text: string): string {
  return text.replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '').trim()
}

/** Check if text looks like a system-injected message */
function isSystemInjected(text: string): boolean {
  const stripped = stripTimestamp(text)
  return (
    stripped.startsWith('[CronResult]') ||
    /^\[Scheduled[:\s]/.test(stripped) ||
    stripped.startsWith('[System Message]') ||
    /^System:\s*\[/.test(text) ||
    /^\(System\)/i.test(stripped) ||
    /^Supervisor[\s:]/i.test(stripped) ||
    /^Write any lasting notes to memory\//i.test(stripped) ||
    stripped.startsWith('[Subagent Context]') ||
    stripped.startsWith('[Subagent Task]') ||
    /^Heartbeat prompt:/i.test(stripped) ||
    stripped === 'HEARTBEAT_OK' ||
    /^OpenClaw runtime context \(internal\):/i.test(stripped)
  )
}

/**
 * Parse raw gateway messages into ParsedTurn[].
 * Groups user→assistant turns, extracts tool calls as work items,
 * strips thinking blocks, and handles system messages.
 */
export function parseTurns(messages: any[]): ParsedTurn[] {
  const turns: ParsedTurn[] = []
  let currentWork: WorkItem[] = []
  let currentThinking: string[] = []
  let lastUserTurn: ParsedTurn | null = null

  for (const m of messages) {
    const role = m.role ?? ''

    if (role === 'user') {
      // If there's a pending user turn without an assistant response, push it
      if (lastUserTurn) {
        turns.push(lastUserTurn)
      }

      const text = extractText(m.content) ?? ''
      const stripped = stripTimestamp(text)
      const cleaned = stripDirectives(stripped)

      // Skip system-injected messages — collapse into system turns
      if (isSystemInjected(text)) {
        const systemTurn: ParsedTurn = {
          role: 'system',
          content: cleaned,
          timestamp: m.timestamp ?? 0,
          workItems: [],
          thinkingBlocks: []
        }
        turns.push(systemTurn)
        lastUserTurn = null
        currentWork = []
        currentThinking = []
        continue
      }

      lastUserTurn = {
        role: 'user',
        content: cleaned,
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
        output: extractText(m.content) ?? undefined,
        toolCallId: m.toolCallId,
        timestamp: m.timestamp ?? 0
      })
      continue
    }

    if (role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : []
      const textParts: string[] = []
      const toolCalls: any[] = []

      if (typeof m.content === 'string') {
        textParts.push(m.content)
      } else {
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text)
          } else if (block.type === 'toolCall') {
            toolCalls.push(block)
          }
        }
      }

      const rawText = textParts.join('\n').trim()
      const cleanedText = stripDirectives(stripThinkingBlocks(rawText)).trim()

      if (toolCalls.length > 0) {
        // This is a mid-turn assistant message with tool calls
        if (cleanedText) {
          currentThinking.push(cleanedText)
          currentWork.push({
            type: 'thinking',
            output: cleanedText,
            timestamp: m.timestamp ?? 0
          })
        }
        for (const tc of toolCalls) {
          currentWork.push({
            type: 'tool_call',
            name: tc.name ?? 'tool',
            input: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
            toolCallId: tc.id,
            timestamp: m.timestamp ?? 0
          })
        }
        continue
      }

      // Final assistant response (no tool calls)
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
        // Empty/suppressed response — still close the turn
        if (lastUserTurn) {
          turns.push(lastUserTurn)
          lastUserTurn = null
        }
        currentWork = []
        currentThinking = []
      }
      continue
    }

    // Other roles (system, etc.)
    const text = extractText(m.content)
    if (text) {
      turns.push({
        role: 'system',
        content: text.trim(),
        timestamp: m.timestamp ?? 0,
        workItems: [],
        thinkingBlocks: []
      })
    }
  }

  // Push any remaining user turn
  if (lastUserTurn) {
    turns.push(lastUserTurn)
  }

  // Filter out noisy internal/system turns
  const filtered = turns.filter((t) => {
    const text = (t.content ?? '').trim()
    if (!text) return true

    // Exact matches
    if (text === 'NO_REPLY' || text === 'ANNOUNCE_SKIP' || text === 'REPLY_SKIP' || text === 'HEARTBEAT_OK')
      return false

    // Starts with
    if (text.startsWith('Agent-to-agent announce step')) return false
    if (text.startsWith('No new comments on')) return false

    // Contains
    if (text.includes('[Internal task completion event]')) return false

    // Scheduled Result HH:MM\nCompaction
    if (/^Scheduled Result \d{2}:\d{2}/.test(text)) return false

    return true
  })

  // Deduplicate consecutive identical messages
  return filtered.filter((t, i) => {
    if (i === 0) return true
    const prev = filtered[i - 1]
    return t.content !== prev.content || t.role !== prev.role
  })
}
