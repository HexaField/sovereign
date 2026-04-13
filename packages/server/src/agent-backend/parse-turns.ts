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

/** Strip the "Sender (untrusted metadata):" envelope from user messages */
function stripSenderEnvelope(text: string): string {
  return text.replace(/^Sender \(untrusted metadata\):\s*```json\s*\{[^}]*\}\s*```\s*/s, '').trim()
}

/** Try to extract a real user message embedded after a system prefix.
 *  Returns the user message text if found, null otherwise. */
function extractEmbeddedUserMessage(text: string): string | null {
  // Pattern: system event text followed by "Sender (untrusted metadata):" user message
  const senderIdx = text.indexOf('Sender (untrusted metadata):')
  if (senderIdx > 0) {
    const userPart = text.substring(senderIdx)
    const cleaned = stripSenderEnvelope(userPart)
    const stripped = stripTimestamp(cleaned)
    if (stripped && stripped.length > 5) return stripped
  }
  return null
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
    /^OpenClaw runtime context \(internal\):/i.test(stripped) ||
    /^Exec (?:completed|failed)\s*\(/i.test(stripped)
  )
}

/** Normalize system-injected message text for rendering. */
function normalizeSystemText(text: string): string {
  const stripped = stripTimestamp(text)
  const isTaskCompletion =
    /^OpenClaw runtime context \(internal\):/i.test(stripped) && /\[Internal task completion event\]/i.test(stripped)
  const isSubagentResult = stripped.startsWith('[System Message]') && /subagent task .* completed/i.test(stripped)
  const isCronResult = stripped.startsWith('[CronResult]')
  const isScheduled = /^\[Scheduled[:\s]/.test(stripped)
  const isSystemEvent = /^System:\s*\[/.test(text)

  if (isTaskCompletion) return stripDirectives(stripped)

  if (isSubagentResult) {
    let cleanText = stripped
      .replace(/^\[System Message\]\s*/, '')
      .replace(/^\[sessionId:\s*[^\]]*\]\s*/, '')
      .trim()
    cleanText = cleanText
      .replace(/\n\nStats:.*$/s, '')
      .replace(/\n\n(?:There are still|A completed subagent task is ready).*$/s, '')
      .trim()
    return stripDirectives(cleanText)
  }

  if (isCronResult) return stripDirectives(stripped.replace(/^\[CronResult\]\s*/, '').trim())
  if (isScheduled) return stripDirectives(stripped.replace(/^\[Scheduled:\s*[^\]]*\]\s*/, '').trim())
  if (isSystemEvent) {
    const cleanText = text
      .replace(/^System:\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+GMT[^\]]*\]\s*/, '')
      .trim()
      .replace(/^Cron\s*\([^)]*\):\s*/, '')
      .trim()
    return stripDirectives(cleanText)
  }

  return stripDirectives(stripped)
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

      // Flush accumulated work items as an assistant turn (handles sessions_yield / subagent spawns
      // where the agent has tool calls but no final text response)
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

      // Skip system-injected messages — collapse into system turns
      if (isSystemInjected(text)) {
        // Check for embedded user message after the system prefix
        const embeddedUser = extractEmbeddedUserMessage(text)
        if (embeddedUser) {
          // Split: system part becomes a system turn (filtered later), user part becomes user turn
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
          const systemTurn: ParsedTurn = {
            role: 'system',
            content: normalizeSystemText(text),
            timestamp: m.timestamp ?? 0,
            workItems: [],
            thinkingBlocks: []
          }
          turns.push(systemTurn)
          lastUserTurn = null
        }
        currentWork = []
        currentThinking = []
        continue
      }

      // Strip sender envelope from regular user messages
      const userText = stripSenderEnvelope(cleaned)
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
        output: extractText(m.content) ?? undefined,
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
          if (block.type === 'toolCall') {
            toolCalls.push(block)
          }
        }
      }

      if (toolCalls.length > 0) {
        // Process blocks in order: emit thinking entries for text blocks, then tool calls
        // This preserves the interleaving of thinking text and tool calls
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
              if (block.name === 'sessions_yield') {
                continue
              }
              currentWork.push({
                type: 'tool_call',
                name: block.name ?? 'tool',
                input: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
                toolCallId: block.id,
                timestamp: m.timestamp ?? 0
              })
            }
          }
        }
        continue
      }

      // No tool calls — collect all text parts for final response
      if (!Array.isArray(m.content) || typeof m.content === 'string') {
        // already in allTextParts
      } else {
        allTextParts = blocks.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text)
      }

      const rawText = allTextParts.join('\n').trim()
      const cleanedText = stripDirectives(stripThinkingBlocks(rawText)).trim()

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

        // Check for error turns (e.g. 429 rate limit) — show error as a system turn
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

    // Other roles (system, etc.)
    const text = extractText(m.content)
    if (text) {
      turns.push({
        role: 'system',
        content: normalizeSystemText(text),
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

  // Flush any remaining work items (e.g., agent yielded or spawned subagent as last action)
  if (currentWork.length > 0) {
    turns.push({
      role: 'assistant',
      content: '',
      timestamp: currentWork[currentWork.length - 1].timestamp ?? 0,
      workItems: currentWork,
      thinkingBlocks: currentThinking
    })
  }

  // Filter out noisy internal/system turns
  const filtered = turns.filter((t) => {
    const text = (t.content ?? '').trim()
    if (!text) return true

    // Exact matches
    if (text === 'NO_REPLY' || text === 'ANNOUNCE_SKIP' || text === 'REPLY_SKIP' || text === 'HEARTBEAT_OK')
      return false

    // Filter exec notifications — these are noise
    if (/^Exec (?:completed|failed)\s*\(/i.test(text)) return false

    // Starts with
    if (text.startsWith('Agent-to-agent announce step')) return false
    if (text.startsWith('No new comments on')) return false

    // Scheduled Result HH:MM\nCompaction
    if (/^Scheduled Result \d{2}:\d{2}/.test(text)) return false

    return true
  })

  // Deduplicate consecutive identical messages (non-user roles)
  const afterConsecutive = filtered.filter((t, i) => {
    if (i === 0) return true
    if (t.role === 'user') return true // user dedup handled by content-hash window below
    const prev = filtered[i - 1]
    return t.content !== prev.content || t.role !== prev.role
  })

  // Content-hash dedup window for user messages:
  // Collapse identical user messages within DEDUP_WINDOW_S seconds,
  // even if separated by system/assistant turns.
  const DEDUP_WINDOW_MS = 10_000
  const seenUser = new Map<string, number>() // content -> timestamp
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
