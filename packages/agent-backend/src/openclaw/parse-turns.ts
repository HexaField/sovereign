// OpenClaw-specific turn parser. Wraps the shared parser with OpenClaw's
// noise-filtering rules: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>`,
// `[CronResult]`, `Sender (untrusted metadata):`, `HEARTBEAT_OK`,
// claude-cli compaction rehydration, etc.

import type { ParsedTurn } from '@sovereign/core'
import { parseTurns as parseTurnsGeneric, stripTimestamp, stripDirectives } from '@sovereign/primitives'

// ── Compaction rehydration ──────────────────────────────────────────
//
// When OpenClaw compacts a claude-cli session, it starts a fresh CLI
// session and injects ONE synthetic user message containing the prior
// transcript summary in `<conversation_history>` and the user's actual
// next message in `<next_user_message>`. We split that into a system
// "compaction" turn + a user turn so the UI renders correctly.

const REHYDRATION_PREFIX = 'Continue this conversation using the OpenClaw transcript below as prior session history.'

interface RehydrationParts {
  conversationHistory: string
  nextUserMessage: string
  /** The `⚙️ Compacted (X before) • Context Y/Z (W%)` marker line if found. */
  compactionMarker: string | null
}

function parseRehydrationMessage(text: string): RehydrationParts | null {
  if (!text.startsWith(REHYDRATION_PREFIX)) return null
  const historyMatch = text.match(/<conversation_history>([\s\S]*?)<\/conversation_history>/)
  const nextMatch = text.match(/<next_user_message>([\s\S]*?)<\/next_user_message>/)
  if (!historyMatch || !nextMatch) return null

  const historyBody = historyMatch[1].trim()
  const nextBody = nextMatch[1].trim()

  // Pull the trailing `Assistant: ⚙️ Compacted (...)` line out of the
  // history body so we can use it as the chip marker.
  const markerLineMatch = historyBody.match(/(?:^|\n)\s*Assistant:\s*(⚙️\s*Compacted\s*\([^\n]*\))\s*$/)
  const compactionMarker = markerLineMatch ? markerLineMatch[1].trim() : null

  let summaryBody = historyBody
  if (markerLineMatch) {
    summaryBody = historyBody.slice(0, markerLineMatch.index).trim()
  }
  // The body typically starts with "Compaction summary:" — keep that
  // for readability; the client renders it as plain markdown.

  return {
    conversationHistory: summaryBody,
    nextUserMessage: nextBody,
    compactionMarker
  }
}

/** Format the compaction system-turn content: chip line + blank line + summary body. */
function formatCompactionSystemContent(parts: RehydrationParts): string {
  const chip = parts.compactionMarker ?? '⚙️ Compacted'
  if (!parts.conversationHistory) return chip
  return `${chip}\n\n${parts.conversationHistory}`
}

/** Strip OpenClaw internal context wrapper markers. */
function stripInternalContextWrapper(text: string): string {
  return text
    .replace(/^<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\s*/, '')
    .replace(/\s*<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\s*$/, '')
}

/** Strip the "Sender (untrusted metadata):" envelope from user messages. */
function stripSenderEnvelope(text: string): string {
  return text.replace(/^Sender \(untrusted metadata\):\s*```json\s*\{[^}]*\}\s*```\s*/s, '').trim()
}

/** Extract a real user message embedded after an OpenClaw system prefix. */
function extractEmbeddedUserMessage(text: string): string | null {
  // Compaction rehydration — extract the <next_user_message> body.
  const rehydration = parseRehydrationMessage(text)
  if (rehydration) {
    const stripped = stripTimestamp(rehydration.nextUserMessage).trim()
    return stripped || rehydration.nextUserMessage
  }
  const senderIdx = text.indexOf('Sender (untrusted metadata):')
  if (senderIdx > 0) {
    const userPart = text.substring(senderIdx)
    const cleaned = stripSenderEnvelope(userPart)
    const stripped = stripTimestamp(cleaned)
    if (stripped && stripped.length > 5) return stripped
  }
  return null
}

/** Detect OpenClaw-injected system noise (heartbeats, cron results, subagent envelopes, ...). */
function isSystemInjected(text: string): boolean {
  const stripped = stripTimestamp(text)
  // Compaction rehydration is handled as a system-injected message whose
  // embedded user is the real next-message body.
  if (text.startsWith(REHYDRATION_PREFIX)) return true
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
    stripped.startsWith('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') ||
    /^Exec (?:completed|failed)\s*\(/i.test(stripped)
  )
}

/** Convert OpenClaw system-injected text into the rendered system-turn body. */
function normalizeSystemText(text: string): string {
  const stripped = stripInternalContextWrapper(stripTimestamp(text))
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

/** Final filter pass: drop OpenClaw-specific noise turns. */
function shouldKeepTurn(turn: ParsedTurn): boolean {
  const text = (turn.content ?? '').trim()
  if (!text) return true

  // Filter exec notifications — these are noise
  if (/^Exec (?:completed|failed)\s*\(/i.test(text)) return false

  if (text.startsWith('Agent-to-agent announce step')) return false
  if (text.startsWith('No new comments on')) return false

  // Scheduled Result HH:MM\nCompaction
  if (/^Scheduled Result \d{2}:\d{2}/.test(text)) return false

  return true
}

const HIDDEN_TOOL_NAMES = new Set(['sessions_yield'])

/** Parse OpenClaw raw gateway messages into ParsedTurn[] with OpenClaw filters applied. */
export function parseTurns(messages: any[]): ParsedTurn[] {
  return parseTurnsGeneric(messages, {
    classifySystemInjected(text) {
      // Compaction rehydration: emit BOTH a compaction system turn (with the
      // ⚙️ marker + summary body) and the embedded next user turn.
      const rehydration = parseRehydrationMessage(text)
      if (rehydration) {
        return {
          systemContent: formatCompactionSystemContent(rehydration),
          preserveWithEmbeddedUser: true
        }
      }
      if (!isSystemInjected(text)) return null
      return { systemContent: normalizeSystemText(text) }
    },
    extractEmbeddedUser: extractEmbeddedUserMessage,
    stripUserEnvelope: stripSenderEnvelope,
    shouldKeepTurn,
    hiddenToolNames: HIDDEN_TOOL_NAMES
  })
}
