/**
 * Sanitize message content by stripping OpenClaw internal metadata
 * that shouldn't be rendered in the chat UI.
 */

/** Strip <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> ... <<<END_OPENCLAW_INTERNAL_CONTEXT>>> blocks */
function stripInternalContext(text: string): string {
  return text.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '').trim()
}

/** Strip System (untrusted): exec notification lines */
function stripExecNotifications(text: string): string {
  return text.replace(/^System \(untrusted\):.*$/gm, '').trim()
}

/** Strip tool call summary lines like ▶ ✓ exec (4), process, ... or ▶ ! ▶ exec (26), ... */
function stripToolCallSummaries(text: string): string {
  return text.replace(/^▶\s*[✓!▶\s]+[\w_]+(?:\s*\(\d+\))?(?:,\s*[\w_]+(?:\s*\(\d+\))?)*\s*$/gm, '').trim()
}

/** Strip System: prefixed lines (e.g. System: [timestamp] Event info) */
function stripSystemPrefixedLines(text: string): string {
  return text.replace(/^System:\s.*$/gm, '').trim()
}

/** Strip Sender (untrusted metadata) envelope + optional timestamp prefix from user messages */
function stripSenderEnvelope(text: string): string {
  // Strip any leading System: block(s) before the Sender envelope
  let result = text.replace(/^(?:System:\s.*\n)+/, '')
  // Strip the envelope header block
  result = result.replace(/^Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/, '')
  // Strip leading timestamp like [Mon 2026-04-13 14:08 GMT+10]
  result = result.replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:\s+GMT[+-]\d+)?\]\s*/,
    ''
  )
  // Strip any remaining System: lines in the body
  result = stripSystemPrefixedLines(result)
  return result.trim()
}

/** Detect compaction messages */
export function isCompactionMessage(content: string): boolean {
  return /^⚙️\s*Compacted\s*\(/.test(content.trim())
}

/**
 * Sanitize message content based on role.
 * Returns cleaned text suitable for rendering.
 */
export function sanitizeContent(role: string, content: string): string {
  if (!content) return content

  // Common: strip internal context blocks and exec notifications from all roles
  let result = stripInternalContext(content)
  result = stripExecNotifications(result)

  if (role === 'assistant') {
    result = stripToolCallSummaries(result)
  }

  if (role === 'user') {
    result = stripSenderEnvelope(result)
  }

  // Collapse multiple blank lines
  result = result.replace(/\n{3,}/g, '\n\n').trim()
  return result
}
