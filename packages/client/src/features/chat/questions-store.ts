// Client-side store for pending AskUserQuestion tool calls.
//
// The server holds the SDK's tool_use in a PreToolUse hook until the user
// submits answers here; the round-trip is:
//
//   agent → AskUserQuestion tool_use
//     → server: PreToolUse hook registers PendingAskUserQuestion
//       → WS `question.pending` broadcast → this store
//         → InlineQuestionCard renders below the requesting turn
//           → user submits → POST /api/threads/:key/questions/:tool/answer
//             → server: hook returns permissionDecision: 'deny' with the
//               JSON payload as the reason (the SDK surfaces the reason as
//               the tool_result content the model reads).
//
// Pending questions are ephemeral (in-memory on the server); on thread open
// the client fetches the current list via REST + subscribes to WS updates.

import { createSignal } from 'solid-js'
import type { PendingAskUserQuestion } from '@sovereign/core'
import type { WsStore } from '../../ws/ws-store.js'

const [pendingQuestions, setPendingQuestions] = createSignal<PendingAskUserQuestion[]>([])

export { pendingQuestions }

/** All pending questions whose SDK tool_use_id matches the given id. */
export function getPendingByToolCallId(toolCallId: string): PendingAskUserQuestion | undefined {
  return pendingQuestions().find((p) => p.toolCallId === toolCallId)
}

/**
 * Submit answers for a pending question. Optimistically removes the entry
 * from the local pending list (the WS `question.answered` broadcast is the
 * authoritative confirmation, but removing early avoids a flicker between
 * the user clicking Submit and the round-trip completing).
 */
export async function submitAnswers(
  threadKey: string,
  toolCallId: string,
  payload: {
    questions: unknown[]
    answers: Record<string, string>
    annotations?: Record<string, { custom?: boolean; notes?: string }>
  }
): Promise<{ ok: boolean; error?: string }> {
  const optimisticallyRemove = pendingQuestions().filter((p) => p.toolCallId !== toolCallId)
  setPendingQuestions(optimisticallyRemove)
  try {
    const res = await fetch(
      `/api/threads/${encodeURIComponent(threadKey)}/questions/${encodeURIComponent(toolCallId)}/answer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    )
    if (!res.ok) {
      // Server rejected the submission — probably a stale toolCallId (session
      // was aborted server-side). Leave it removed; the tool call surface
      // won't try to render it again.
      const body = await res.json().catch(() => ({}))
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Wire the pending-questions store to WS + REST for the given thread. Returns
 * a teardown that unsubscribes from WS and clears the pending list. Called
 * from `initChatStore` alongside the SSE setup.
 */
export function initQuestionsStore(threadKey: string, ws: WsStore): () => void {
  // Prime the list from the server — the WS stream only carries deltas.
  fetch(`/api/threads/${encodeURIComponent(threadKey)}/questions/pending`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.pending && Array.isArray(data.pending)) setPendingQuestions(data.pending)
    })
    .catch(() => {
      /* first-render best-effort; WS deltas will backfill */
    })

  const offs: Array<() => void> = []

  offs.push(
    ws.on('question.pending', (msg: any) => {
      const entry = msg as PendingAskUserQuestion
      if (!entry?.toolCallId) return
      setPendingQuestions((prev) => {
        // De-dup by toolCallId — a session resume can re-fire the same tool.
        const filtered = prev.filter((p) => p.toolCallId !== entry.toolCallId)
        return [...filtered, entry]
      })
    })
  )

  offs.push(
    ws.on('question.answered', (msg: any) => {
      const id = msg?.toolCallId
      if (!id) return
      setPendingQuestions((prev) => prev.filter((p) => p.toolCallId !== id))
    })
  )

  offs.push(
    ws.on('question.aborted', (msg: any) => {
      const id = msg?.toolCallId
      if (!id) return
      setPendingQuestions((prev) => prev.filter((p) => p.toolCallId !== id))
    })
  )

  return () => {
    for (const off of offs) off()
    setPendingQuestions([])
  }
}
