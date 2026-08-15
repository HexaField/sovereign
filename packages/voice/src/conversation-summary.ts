// Conversation Summary Module — rolling summary for the presence gateway
// thread, surfaced as a header bubble in the client.
//
// Scope: the presence gateway thread ONLY (the user's primary text-chat
// surface with Hex). Every other thread never triggers a summary update —
// see `config().gatewayThreadId`. In-memory only; a restart clears every
// entry, which matches the "rolling, current-state" nature of the feature
// (nothing downstream expects a summary to survive a reboot).
//
// Mirrors `voice-response.ts`'s dependency-injection shape: no cross-package
// imports, fire-and-forget generation that never delays or blocks the main
// chat response pipeline.

import type { EventBus } from '@sovereign/core'
import { Router } from 'express'
import type { LlmCompleter } from './voice-response.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface ConversationSummaryConfig {
  enabled: boolean
  /** The presence gateway thread id, or null when not yet provisioned.
   *  A summary update fires only for turns landing on this thread. */
  gatewayThreadId: string | null
  /** System prompt for running summary generation. When empty, uses a
   *  built-in generic default. */
  systemPrompt: string
}

export interface ConversationSummaryDeps {
  bus: EventBus
  /** Lightweight LLM for summary generation (local-llm inference client). */
  llm: LlmCompleter
  /** Fetch the last N turns for a thread — used to pair the completed
   *  assistant turn with the user message that prompted it. */
  getRecentTurns: (threadId: string, limit: number) => Promise<Array<{ role: string; content: string }>>
  /** Current config (called per-event so hot-reload and gateway-thread
   *  reassignment both take effect immediately). */
  config: () => ConversationSummaryConfig
}

// ── Prompt default ────────────────────────────────────────────────────
// Generic, personality-free fallback. Production deployments override
// via config.json → voice.prompts.conversationSummarySystem.

const DEFAULT_SUMMARY_SYSTEM = `You maintain a running summary of a conversation between a user and their AI assistant.
Given the previous summary and the latest exchange (user message + assistant response),
produce an updated summary that captures the key points, decisions, and current state.

Rules:
- Keep under 4 sentences.
- Focus on what happened, what got decided, and what remains open.
- Never use markdown, code, or special formatting.
- Write in third person ("The user asked...", "The assistant implemented...").`

// ── Module ─────────────────────────────────────────────────────────────

export function createConversationSummary(deps: ConversationSummaryDeps) {
  const { bus, llm, getRecentTurns, config } = deps

  // Latest summary text per thread, in memory only. In practice only the
  // gateway thread ever gets an entry — keyed by threadId (not a single
  // slot) so a gateway-role reassignment mid-session never mixes summaries
  // from two different threads.
  const summaries = new Map<string, string>()

  // Guards against two summary calls racing for the same thread (e.g. a
  // resumed session replaying turns quickly) — a race would let the
  // slower response overwrite the faster one with stale context.
  const inFlight = new Set<string>()

  async function generateSummary(threadId: string, assistantText: string): Promise<void> {
    if (inFlight.has(threadId)) return
    inFlight.add(threadId)

    try {
      // Pair the completed assistant turn with the user message that
      // prompted it — the bus event carries only the assistant side.
      let userText = ''
      try {
        const recent = await getRecentTurns(threadId, 4)
        const lastUser = [...recent].reverse().find((t) => t.role === 'user')
        userText = lastUser?.content ?? ''
      } catch {
        // Proceed without the paired user message — the assistant
        // response alone still carries summarizable content.
      }

      const cfg = config()
      const existing = summaries.get(threadId) ?? ''
      const exchange = userText
        ? `User: ${userText.slice(0, 1000)}\n\nAssistant: ${assistantText.slice(0, 2000)}`
        : `Assistant: ${assistantText.slice(0, 2000)}`

      const systemPrompt = cfg.systemPrompt || DEFAULT_SUMMARY_SYSTEM
      type Role = 'system' | 'user' | 'assistant' | 'tool'
      const messages: Array<{ role: Role; content: string }> = [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Previous summary:\n${existing || '(none yet — this opens the conversation)'}\n\nLatest exchange:\n${exchange}\n\nProduce the updated summary.`
        }
      ]

      const completion = await llm.complete(messages)
      const summaryText = completion.choices?.[0]?.message?.content?.trim()
      if (!summaryText) return

      summaries.set(threadId, summaryText)

      bus.emit({
        type: 'chat.summary.updated',
        timestamp: new Date().toISOString(),
        source: 'conversation-summary',
        payload: { threadId, summary: summaryText }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[conversation-summary] update failed for ${threadId}: ${msg}`)
    } finally {
      inFlight.delete(threadId)
    }
  }

  // ── Event subscription ────────────────────────────────────────────

  const unsubscribe = bus.on('chat.turn.completed', (event) => {
    const payload = event.payload as {
      threadId?: string
      turn?: { role?: string; content?: string }
    }
    if (!payload?.threadId) return
    if (payload.turn?.role !== 'assistant') return
    if (!payload.turn?.content) return

    const cfg = config()
    if (!cfg.enabled) return
    if (!cfg.gatewayThreadId || payload.threadId !== cfg.gatewayThreadId) return

    // Fire-and-forget — never delay or block the chat response pipeline.
    void generateSummary(payload.threadId, payload.turn.content)
  })

  return {
    /** Current summary text for a thread, or empty string when none exists
     *  yet (never generated, or the thread never carried the gateway role). */
    getSummary(threadId: string): string {
      return summaries.get(threadId) ?? ''
    },
    /** Cleanup — drop the bus subscription and clear in-memory state. */
    shutdown() {
      unsubscribe()
      summaries.clear()
      inFlight.clear()
    }
  }
}

export type ConversationSummary = ReturnType<typeof createConversationSummary>

// ── REST routes ────────────────────────────────────────────────────────
// GET /api/threads/:threadId/summary — initial load / page refresh. Live
// updates arrive over WS as `chat.summary` (see bootstrap.ts, which forwards
// the `chat.summary.updated` bus event to the chat channel).

export function createConversationSummaryRoutes(summary: ConversationSummary): Router {
  const router = Router()

  router.get('/api/threads/:threadId/summary', (req, res) => {
    const { threadId } = req.params
    const text = summary.getSummary(threadId)
    if (!text) {
      res.status(404).json({ error: 'No summary available for this thread' })
      return
    }
    res.json({ threadId, summary: text })
  })

  return router
}
