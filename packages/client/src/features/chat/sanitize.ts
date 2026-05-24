/**
 * Sanitize message content by stripping agent-runtime internal metadata that
 * shouldn't be rendered in the chat UI. The server's per-backend adapter is
 * the authoritative scrubber; this is a defense-in-depth pass on the client.
 */

/**
 * Strip `<<<BEGIN_*_INTERNAL_CONTEXT>>> ... <<<END_*_INTERNAL_CONTEXT>>>`
 * blocks emitted by any backend.
 */
function stripInternalContext(text: string): string {
  return text.replace(/<<<BEGIN_[A-Z]+_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_[A-Z]+_INTERNAL_CONTEXT>>>/g, '').trim()
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
  let result = text.replace(/^(?:System:\s.*\n)+/, '')
  result = result.replace(/^Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/, '')
  result = result.replace(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:\s+GMT[+-]\d+)?\]\s*/,
    ''
  )
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

  let result = stripInternalContext(content)
  result = stripExecNotifications(result)

  if (role === 'assistant') {
    result = stripToolCallSummaries(result)
  }

  if (role === 'user') {
    result = stripSenderEnvelope(result)
  }

  result = result.replace(/\n{3,}/g, '\n\n').trim()
  return result
}
