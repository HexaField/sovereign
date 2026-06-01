// Claude Code message classifier. Pure functions: given a `ParsedTurn` whose
// content still carries its raw on-wire envelope (Sovereign cron prefix,
// Claude Code `<task-notification>` / `<invoke>` tags, the `⚙️ Compacted` SDK
// marker, etc.), return an updated turn with a structured `kind` discriminator
// and a cleaned `content` body. The UI switches on `kind.variant` to render
// the right card and never has to re-parse the envelope.
//
// This is the ONLY place Claude-Code-specific text patterns are decoded.
// `parseTurns` (the generic, backend-agnostic parser) hands every turn through
// `classifyClaudeCodeTurn` and `events.ts` calls the same function for live
// emissions so history and live turns share one classifier.

import type { ParsedTurn, TurnKind } from '@sovereign/core'

// ── Cron envelope ────────────────────────────────────────────────────
// Sovereign's scheduler wraps cron-fired prompts as `[Cron: <label> @ <time>]`.
// The body that follows is the prompt that the user/scheduler intended for the
// agent. Surfacing this as a normal user bubble would (a) hide that it was
// scheduler-driven and (b) discard the schedule time. Flip role to system,
// keep the body as content, and stash `label` + `firedAt`.
const CRON_RE = /^\[Cron:\s*([^@\]]+?)(?:\s*@\s*([^\]]+?))?\]\s*/

function parseFiredAt(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const t = Date.parse(trimmed)
  return Number.isFinite(t) ? t : undefined
}

function classifyCron(content: string): { content: string; kind: TurnKind } | null {
  const m = content.match(CRON_RE)
  if (!m) return null
  const label = (m[1] ?? '').trim() || 'cron'
  const firedAt = parseFiredAt(m[2])
  return {
    content: content.slice(m[0].length).trim(),
    kind: {
      variant: 'cron-fired',
      label: `Cron: ${label}`,
      firedAt,
      payload: { label, firedAtRaw: m[2]?.trim() }
    }
  }
}

// ── <task-notification> ──────────────────────────────────────────────
// Emitted by the Claude Code SDK when a background task transitions state
// (subagent finished, scheduled wake-up delivered, etc.). The wire form is
// `<task-notification>BODY</task-notification>` where BODY is either a free-
// text status line or a `key: value` block. We treat it as a system card and
// surface the structured fields when we can parse them.
const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/i

function parseKeyValueBlock(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.+?)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

function classifyTaskNotification(content: string): { content: string; kind: TurnKind } | null {
  const m = content.match(TASK_NOTIFICATION_RE)
  if (!m) return null
  const body = m[1].trim()
  const fields = parseKeyValueBlock(body)
  const taskName = fields.task ?? fields.name ?? fields.title
  const status = fields.status ?? fields.state
  const label = taskName
    ? `Task: ${taskName}${status ? ` — ${status}` : ''}`
    : status
      ? `Task notification — ${status}`
      : 'Task notification'
  return {
    content: body,
    kind: {
      variant: 'task-notification',
      label,
      firedAt: parseFiredAt(fields.timestamp ?? fields.firedAt ?? fields.at),
      payload: Object.keys(fields).length > 0 ? fields : { raw: body }
    }
  }
}

// ── <invoke> ─────────────────────────────────────────────────────────
// Anthropic's tool-call XML format that occasionally leaks into rendered text
// when the SDK surfaces a raw model invocation (e.g. `<invoke name="Tool">
// <parameter name="x">v</parameter></invoke>`). Render as a system card with
// the tool name + extracted parameters; never as a user bubble.
const INVOKE_RE = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/i
const INVOKE_NAME_RE = /\bname\s*=\s*"([^"]+)"/i
const INVOKE_PARAM_RE = /<parameter\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/gi

function classifySdkInvoke(content: string): { content: string; kind: TurnKind } | null {
  const m = content.match(INVOKE_RE)
  if (!m) return null
  const attrs = m[1] ?? ''
  const inner = m[2] ?? ''
  const nameMatch = attrs.match(INVOKE_NAME_RE)
  const toolName = nameMatch?.[1] ?? 'tool'
  const params: Record<string, string> = {}
  for (const p of inner.matchAll(INVOKE_PARAM_RE)) {
    params[p[1]] = p[2].trim()
  }
  return {
    content: inner.trim(),
    kind: {
      variant: 'sdk-invoke',
      label: `Invoke: ${toolName}`,
      payload: { tool: toolName, params }
    }
  }
}

// ── Compaction marker ────────────────────────────────────────────────
// `normalizeClaudeCodeEntry` and `handleCompactBoundary` both emit a system
// turn whose content starts with `⚙️ Compacted`. Tagging it here means the UI
// branch is `kind === 'compaction'` instead of a regex on content.
const COMPACTION_RE = /^⚙️\s*Compacted\b/

function classifyCompaction(content: string): { content: string; kind: TurnKind } | null {
  const trimmed = content.trim()
  if (!COMPACTION_RE.test(trimmed)) return null
  return {
    content: trimmed,
    kind: { variant: 'compaction', label: trimmed }
  }
}

// ── Agent error ──────────────────────────────────────────────────────
// `parseTurns` emits a system turn with content `Error: <message>` when an
// assistant turn ends with `stop_reason: 'error'`. Tag for the error card.
const ERROR_RE = /^Error:\s*/i

function classifyAgentError(content: string): { content: string; kind: TurnKind } | null {
  if (!ERROR_RE.test(content)) return null
  return {
    content: content.replace(ERROR_RE, '').trim(),
    kind: { variant: 'agent-error', label: 'Agent Error' }
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────

/**
 * Run a parsed turn through the Claude Code classification pipeline. Returns
 * a new turn with `kind` set (when an envelope was matched), `content`
 * stripped of that envelope, and `role` flipped to `'system'` for envelopes
 * that should render as cards rather than bubbles (cron, task-notification,
 * sdk-invoke).
 *
 * Turns whose content matches no envelope pass through untouched — the common
 * case is a plain user message or assistant reply.
 */
export function classifyClaudeCodeTurn(turn: ParsedTurn): ParsedTurn {
  // System turns: tag compaction / error so the UI switch can branch on kind.
  if (turn.role === 'system') {
    const compaction = classifyCompaction(turn.content)
    if (compaction) return { ...turn, content: compaction.content, kind: compaction.kind }
    const err = classifyAgentError(turn.content)
    if (err) return { ...turn, content: err.content, kind: err.kind }
    return turn
  }

  // User turns: detect envelopes that should render as cards. Order matters —
  // cron prefix may wrap the other tags, so try it first.
  if (turn.role === 'user') {
    const cron = classifyCron(turn.content)
    if (cron) {
      // The cron body itself can contain another envelope (rare but possible
      // — e.g. a notification delivered via cron). Re-classify the inner body
      // so the most specific kind wins.
      const inner = classifyClaudeCodeTurn({ ...turn, content: cron.content })
      if (inner.kind && inner.role === 'system') {
        return {
          ...inner,
          kind: {
            ...inner.kind,
            firedAt: inner.kind.firedAt ?? cron.kind.firedAt,
            payload: { ...cron.kind.payload, ...inner.kind.payload }
          }
        }
      }
      return { ...turn, role: 'system', content: cron.content, kind: cron.kind }
    }

    const notif = classifyTaskNotification(turn.content)
    if (notif) return { ...turn, role: 'system', content: notif.content, kind: notif.kind }

    const invoke = classifySdkInvoke(turn.content)
    if (invoke) return { ...turn, role: 'system', content: invoke.content, kind: invoke.kind }

    return turn
  }

  // Assistant turns are never card-classified — they're the model's reply.
  return turn
}
