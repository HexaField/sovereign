// AskUserQuestion — first-class support for Claude Code's built-in question tool.
//
// Claude Code ships an SDK tool named `AskUserQuestion` that the CLI's TUI
// answers interactively. In a headless SDK session the SDK auto-fails it with
// `is_error: true, content: "Answer questions?"` — the agent sees an error and
// stops. Sovereign intercepts the tool via a PreToolUse hook, holds the call
// pending until the user submits, then returns the answers as the tool result
// (through `permissionDecision: 'deny'` with a formatted JSON reason — the SDK
// surfaces the reason string as the tool_result content the model reads).
//
// This file only defines the wire shapes shared between server + client + the
// on-disk tool_result JSON we persist for history rendering. The store, hook
// integration, routes, and UI live in their respective packages.

/** One selectable option within an AskUserQuestion. */
export interface AskUserQuestionOption {
  label: string
  description: string
  /** Optional preview content (markdown or html per `toolConfig.askUserQuestion.previewFormat`). */
  preview?: string
}

/** One question in an AskUserQuestion tool call. */
export interface AskUserQuestionItem {
  question: string
  /** Short chip label (≤ 12 chars) shown in the header. */
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

/** Raw tool_input for the AskUserQuestion tool, as emitted by the SDK. */
export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[]
}

/**
 * The shape we persist inside the tool_result content and expose to the
 * client. `answers` is keyed by question text (matching Claude's own
 * `AskUserQuestionOutput.answers` shape) so the model reads a familiar payload.
 * Values are the chosen option label for single-select, comma-separated labels
 * for multi-select, or the user's free-text when they pick "Other".
 */
export interface AskUserQuestionAnswers {
  questions: AskUserQuestionItem[]
  answers: Record<string, string>
  /** Per-question annotations (whether the answer was custom-typed vs option-picked, free-text notes). */
  annotations?: Record<string, { custom?: boolean; notes?: string }>
}

/** Wire-format tool_result content emitted by Sovereign once the user submits. */
export interface AskUserQuestionResult extends AskUserQuestionAnswers {
  /** Discriminator so the client's tool-result parser can distinguish this shape from raw text. */
  kind: 'sovereign:ask-user-question'
  /** When the user submitted. */
  answeredAt: number
}

/** In-memory representation of a pending question waiting for the user. */
export interface PendingAskUserQuestion {
  toolCallId: string
  threadId: string
  input: AskUserQuestionInput
  createdAt: number
}

/**
 * Attempt to parse a tool_result content string into our answers shape.
 * Returns null if the content isn't a Sovereign-formatted AskUserQuestion
 * result (older sessions, non-answered "Answer questions?" errors, etc.).
 */
export function parseAskUserQuestionResult(content: string | undefined): AskUserQuestionResult | null {
  if (!content) return null
  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<AskUserQuestionResult>
    if (parsed?.kind !== 'sovereign:ask-user-question') return null
    if (!Array.isArray(parsed.questions) || typeof parsed.answers !== 'object' || parsed.answers === null) return null
    return parsed as AskUserQuestionResult
  } catch {
    return null
  }
}

/** True iff a workItem is a Claude-Code AskUserQuestion tool call. */
export function isAskUserQuestionToolName(name: string | undefined): boolean {
  return name === 'AskUserQuestion'
}
