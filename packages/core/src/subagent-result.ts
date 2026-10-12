// The message an agents_spawn subagent's result arrives as in its parent
// thread. The server formats it (claude-code backend); the history classifier
// and the client parse it back to render a result card.
//
//   [Subagent done: <label>] after <n> min
//   [Subagent failed: <label>] after <n> min — <error>
//
//   <report body, may be empty>
//
//   Session: <child session key>

export interface SubagentResult {
  status: 'done' | 'failed'
  label: string
  minutes: number
  error?: string
  /** The subagent's report (markdown); empty when it wrote none. */
  body: string
  sessionKey?: string
}

/** Longest report body carried in the message; the transcript holds the rest. */
const MAX_BODY = 12_000

export function formatSubagentResult(opts: {
  label: string
  sessionKey: string
  durationMs: number
  result?: string
  error?: string
}): string {
  const mins = Math.max(1, Math.round(opts.durationMs / 60_000))
  const head = opts.error
    ? `[Subagent failed: ${opts.label}] after ${mins} min — ${opts.error}`
    : `[Subagent done: ${opts.label}] after ${mins} min`
  const body = (opts.result ?? '').trim()
  const text =
    body.length > MAX_BODY
      ? `${body.slice(0, MAX_BODY)}\n\n… (truncated; full transcript in session ${opts.sessionKey})`
      : body
  return [head, text, `Session: ${opts.sessionKey}`].filter(Boolean).join('\n\n')
}

const HEAD_RE = /^\[Subagent (done|failed): ([^\]\n]*)\] after (\d+) min(?: — ([^\n]*))?/
const SESSION_RE = /(?:^|\n\n)Session: (\S+)\s*$/

/** Parse a subagent result message; null for any other text. */
export function parseSubagentResult(content: string): SubagentResult | null {
  const text = content.trim()
  const head = HEAD_RE.exec(text)
  if (!head) return null
  let rest = text.slice(head[0].length)
  const session = SESSION_RE.exec(rest)
  if (session) rest = rest.slice(0, session.index)
  return {
    status: head[1] as 'done' | 'failed',
    label: head[2].trim(),
    minutes: Number(head[3]),
    ...(head[4] ? { error: head[4].trim() } : {}),
    body: rest.trim(),
    ...(session ? { sessionKey: session[1] } : {})
  }
}
