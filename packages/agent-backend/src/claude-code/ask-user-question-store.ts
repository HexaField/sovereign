// Pending-question registry for the AskUserQuestion tool.
//
// The PreToolUse hook calls `register(threadId, toolCallId, input)` and awaits
// the returned promise. The chat route calls `submit(toolCallId, answers)` to
// resolve it, which unblocks the hook and lets it return the answers to the
// SDK as the tool_result content.
//
// Pending entries live in memory only — a Sovereign restart mid-question drops
// the pending record; the SDK re-fires the tool on session resume, so the user
// sees the question again with the same tool_use_id. That's fine: the whole
// point of the hook is that the SDK can't proceed until answered, so there's
// no risk of orphaned answers arriving after a resolved call.

import type { EventBus } from '@sovereign/core'
import type { AskUserQuestionInput, AskUserQuestionResult, PendingAskUserQuestion } from '@sovereign/core'

interface PendingEntry {
  entry: PendingAskUserQuestion
  resolve: (result: AskUserQuestionResult) => void
  reject: (err: Error) => void
}

export interface AskUserQuestionStore {
  /**
   * Register a pending question and return a promise that resolves with the
   * answers the user submits. If the caller aborts (e.g. session shutdown),
   * `abort(toolCallId)` rejects the promise so the hook can clean up.
   */
  register(threadId: string, toolCallId: string, input: AskUserQuestionInput): Promise<AskUserQuestionResult>
  /** Submit the user's answers. Returns false if no pending entry matches. */
  submit(toolCallId: string, answers: Omit<AskUserQuestionResult, 'kind' | 'answeredAt'>): boolean
  /** Reject an outstanding entry (session abort, timeout, restart). No-op if unknown. */
  abort(toolCallId: string, reason?: string): void
  /** List pending questions, optionally filtered by thread. */
  listPending(threadId?: string): PendingAskUserQuestion[]
  /** Get a single pending entry, if it exists. */
  getPending(toolCallId: string): PendingAskUserQuestion | undefined
}

export function createAskUserQuestionStore(bus?: EventBus): AskUserQuestionStore {
  const pending = new Map<string, PendingEntry>()

  return {
    register(threadId, toolCallId, input) {
      // Reject the previous entry for the same toolCallId if any — happens
      // when a session resume re-fires the tool before the old one cleared.
      const existing = pending.get(toolCallId)
      if (existing) existing.reject(new Error('superseded by re-registration'))
      return new Promise<AskUserQuestionResult>((resolve, reject) => {
        const entry: PendingAskUserQuestion = { toolCallId, threadId, input, createdAt: Date.now() }
        pending.set(toolCallId, { entry, resolve, reject })
        bus?.emit({
          type: 'question.pending',
          timestamp: new Date().toISOString(),
          source: 'ask-user-question',
          payload: entry
        })
      })
    },

    submit(toolCallId, answers) {
      const p = pending.get(toolCallId)
      if (!p) return false
      pending.delete(toolCallId)
      const result: AskUserQuestionResult = {
        kind: 'sovereign:ask-user-question',
        questions: answers.questions,
        answers: answers.answers,
        annotations: answers.annotations,
        answeredAt: Date.now()
      }
      p.resolve(result)
      bus?.emit({
        type: 'question.answered',
        timestamp: new Date().toISOString(),
        source: 'ask-user-question',
        payload: { toolCallId, threadId: p.entry.threadId, result }
      })
      return true
    },

    abort(toolCallId, reason = 'aborted') {
      const p = pending.get(toolCallId)
      if (!p) return
      pending.delete(toolCallId)
      p.reject(new Error(reason))
      bus?.emit({
        type: 'question.aborted',
        timestamp: new Date().toISOString(),
        source: 'ask-user-question',
        payload: { toolCallId, threadId: p.entry.threadId, reason }
      })
    },

    listPending(threadId) {
      const entries: PendingAskUserQuestion[] = []
      for (const { entry } of pending.values()) {
        if (!threadId || entry.threadId === threadId) entries.push(entry)
      }
      // Oldest first — matches the natural chronological order the user sees.
      entries.sort((a, b) => a.createdAt - b.createdAt)
      return entries
    },

    getPending(toolCallId) {
      return pending.get(toolCallId)?.entry
    }
  }
}
