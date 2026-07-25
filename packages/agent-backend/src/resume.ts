// Boot-time resume orchestrator. Runs after backends connect and before
// HTTP traffic is served (R10). Walks every entry in `active-sessions.json`
// and applies the three-tier policy from PRINCIPLES + spec:
//
//   Tier 1 — Queue replay (R11): repump any `sending` head whose
//            inFlightQueueId matches.
//   Tier 2 — JSONL coherence (R12): drop the entry when the assistant turn
//            actually completed before SIGTERM. Invalidate when the session
//            file is gone.
//   Tier 3 — Auto-continue (R13): synthesize a continuation send for
//            sessions that were working but had no queued user message.
//
// Subagents are preserved through resume (R14) — the parent SDK session's
// natural rehydration is responsible for re-firing SubagentStart. We only
// emit synthetic `subagent.completed` when the parent itself fails Tier 2.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { ActiveSessions, ActiveSessionEntry } from './active-sessions.js'
import type { RoutingBackend } from './factory.js'

export interface ResumeOrchestratorOptions {
  activeSessions: ActiveSessions
  routingBackend: RoutingBackend
  bus: EventBus
  /** Read-only snapshot of every thread's message queue. */
  getAllQueues(): Map<string, Array<{ id: string; status: string; text: string }>>
  /** Re-queues a queued/sending head and triggers a pump. Returns true on success. */
  replayQueueHead(queueId: string): boolean
  /** Drop a queue head by id (used after Tier 2 sees the turn actually finished). */
  dropQueueHead(queueId: string): void
  /** Synthesize a continuation send via the chat module so it appears in the queue/UI. */
  sendContinuation(threadKey: string, text: string): Promise<void> | void
  /** Optional override for the continuation marker. */
  continuationMarker?: string
}

const DEFAULT_CONTINUATION_MARKER = '[Resumed after server restart. Continue from where you left off.]'

export interface ResumeOutcome {
  sessionKey: string
  threadKey: string
  tier: 1 | 2 | 3 | 'invalidated' | 'tool-await' | 'passthrough'
  reason: string
}

export interface ResumeReport {
  outcomes: ResumeOutcome[]
  counts: {
    tier1: number
    tier2: number
    tier3: number
    invalidated: number
    /** Sessions the PreToolUse hook was holding open when we shut down.
     *  Left to the SDK's own tool re-fire on session resume. */
    toolAwait: number
    /** Sessions with `working` status but no evidence of an in-flight user
     *  prompt or tool-await — SDK session resume handles them naturally. */
    passthrough: number
  }
}

export async function resumeActiveSessions(opts: ResumeOrchestratorOptions): Promise<ResumeReport> {
  const marker = opts.continuationMarker ?? DEFAULT_CONTINUATION_MARKER
  const outcomes: ResumeOutcome[] = []
  const counts = { tier1: 0, tier2: 0, tier3: 0, invalidated: 0, toolAwait: 0, passthrough: 0 }

  const entries = opts.activeSessions.list()
  if (entries.length === 0) return { outcomes, counts }

  // Snapshot all queues once — handful of items per thread, cheap.
  const queues = opts.getAllQueues()
  const queueByThread = new Map<string, Array<{ id: string; status: string; text: string }>>()
  for (const [tk, items] of queues) queueByThread.set(tk, items)

  for (const entry of entries) {
    const outcome = await resolveOne({
      entry,
      queueItems: queueByThread.get(entry.threadKey) ?? [],
      activeSessions: opts.activeSessions,
      bus: opts.bus,
      replayQueueHead: opts.replayQueueHead,
      dropQueueHead: opts.dropQueueHead,
      sendContinuation: opts.sendContinuation,
      marker
    })
    outcomes.push(outcome)
    if (outcome.tier === 1) counts.tier1++
    else if (outcome.tier === 2) counts.tier2++
    else if (outcome.tier === 3) counts.tier3++
    else if (outcome.tier === 'tool-await') counts.toolAwait++
    else if (outcome.tier === 'passthrough') counts.passthrough++
    else counts.invalidated++
  }

  // Single bus event with the summary so the timeline records it (R18).
  opts.bus.emit({
    type: 'system.resume',
    timestamp: new Date().toISOString(),
    source: 'agent-backend',
    payload: { counts, outcomes }
  })

  for (const o of outcomes) {
    console.log(`[resume] ${o.sessionKey} → tier=${o.tier} reason=${o.reason}`)
  }

  return { outcomes, counts }
}

interface ResolveOneArgs {
  entry: ActiveSessionEntry
  queueItems: Array<{ id: string; status: string; text: string }>
  activeSessions: ActiveSessions
  bus: EventBus
  replayQueueHead: ResumeOrchestratorOptions['replayQueueHead']
  dropQueueHead: ResumeOrchestratorOptions['dropQueueHead']
  sendContinuation: ResumeOrchestratorOptions['sendContinuation']
  marker: string
}

async function resolveOne(args: ResolveOneArgs): Promise<ResumeOutcome> {
  const { entry } = args

  // ── Tier 2 prerequisite: the backend session file must still exist. ──
  if (entry.backendSessionFile && !fs.existsSync(entry.backendSessionFile)) {
    args.activeSessions.remove(entry.sessionKey)
    invalidateSubagents(args, entry, 'session-file-missing')
    return {
      sessionKey: entry.sessionKey,
      threadKey: entry.threadKey,
      tier: 'invalidated',
      reason: 'session-file-missing'
    }
  }

  // ── Tool-await short-circuit ──────────────────────────────────────
  // The PreToolUse hook was holding the SDK open (currently
  // AskUserQuestion) at shutdown. The SDK re-fires the tool_use on
  // session resume, so a fresh hook invocation will re-register the
  // pending entry naturally — we must NOT synthesize a continuation
  // here, or the user gets both a re-opened question card AND a stray
  // "Resumed after server restart" user message on top of the tool
  // re-fire. Leave the active-sessions entry in place; when the hook
  // fires again on resume, `setPendingToolAwait` will refresh it (and
  // `clearPendingToolAwait` will drop it once the user submits).
  if (entry.pendingToolAwait) {
    return {
      sessionKey: entry.sessionKey,
      threadKey: entry.threadKey,
      tier: 'tool-await',
      reason: `sdk-will-re-fire-${entry.pendingToolAwait.toolName}`
    }
  }

  // ── Tier 2 — JSONL coherence: did the assistant turn actually complete? ──
  if (
    entry.backendSessionFile &&
    entry.inFlightPromptText &&
    typeof entry.lastJsonlSize === 'number' &&
    jsonlHasCompletedTurn(entry.backendSessionFile, entry.inFlightPromptText, entry.lastJsonlSize)
  ) {
    args.activeSessions.remove(entry.sessionKey)
    if (entry.inFlightQueueId) args.dropQueueHead(entry.inFlightQueueId)
    return {
      sessionKey: entry.sessionKey,
      threadKey: entry.threadKey,
      tier: 2,
      reason: 'turn-completed-before-shutdown'
    }
  }

  // ── Tier 1 — Queue replay: re-pump the in-flight queue head. ──
  if (entry.inFlightQueueId) {
    const head = args.queueItems[0]
    if (head && head.id === entry.inFlightQueueId && (head.status === 'sending' || head.status === 'queued')) {
      const ok = args.replayQueueHead(head.id)
      if (ok) return { sessionKey: entry.sessionKey, threadKey: entry.threadKey, tier: 1, reason: 'queue-replay' }
    }
  }

  // ── Tier 3 — Auto-continue, gated by evidence of an in-flight prompt ──
  // Historically fired unconditionally as a safety net, but for sessions
  // whose `working` state came from a mid-tool situation with no queue
  // record, injecting `[Resumed…]` produces a spurious user turn on top
  // of the SDK's own tool re-fire. Only fabricate a continuation when
  // we have concrete evidence a user message was in flight
  // (`inFlightPromptText` was set). Otherwise the SDK's session resume
  // is the right authority — leave the entry alone and let the natural
  // re-emission of the current turn's blocks flow through.
  if (entry.inFlightPromptText) {
    await Promise.resolve(args.sendContinuation(entry.threadKey, args.marker))
    return { sessionKey: entry.sessionKey, threadKey: entry.threadKey, tier: 3, reason: 'auto-continue' }
  }

  return {
    sessionKey: entry.sessionKey,
    threadKey: entry.threadKey,
    tier: 'passthrough',
    reason: 'no-inflight-no-tool-await'
  }
}

/** Emit synthetic `subagent.completed` for the parent's tracked children when
 * the parent itself is invalidated by Tier 2 (R14). */
function invalidateSubagents(args: ResolveOneArgs, entry: ActiveSessionEntry, _why: string): void {
  if (!entry.subagents?.length) return
  for (const sub of entry.subagents) {
    args.bus.emit({
      type: 'subagent.completed',
      timestamp: new Date().toISOString(),
      source: 'agent-backend',
      payload: {
        parentKey: entry.sessionKey,
        childKey: `agent:main:subagent:${sub.agentId}`,
        result: '[interrupted — underlying session unavailable]'
      }
    })
  }
}

/**
 * Tail-scan the JSONL to determine whether the agent emitted a complete
 * assistant turn after the user message identified by `promptText`. We only
 * inspect bytes past `lastJsonlSize` — that's the window that arrived after
 * our snapshot last persisted.
 */
function jsonlHasCompletedTurn(filePath: string, promptText: string, lastJsonlSize: number): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size <= lastJsonlSize) return false
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(stat.size - lastJsonlSize)
    fs.readSync(fd, buf, 0, buf.length, lastJsonlSize)
    fs.closeSync(fd)
    const lines = buf.toString('utf-8').split('\n').filter(Boolean)
    let sawPrompt = false
    let sawAssistantAfterPrompt = false
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (e.type === 'user' && messageContains(e.message, promptText)) sawPrompt = true
        if (sawPrompt && e.type === 'assistant' && e.message?.stop_reason) sawAssistantAfterPrompt = true
      } catch {
        /* skip malformed */
      }
    }
    return sawAssistantAfterPrompt
  } catch {
    return false
  }
}

function messageContains(message: any, needle: string): boolean {
  if (!message) return false
  const content = message.content
  if (typeof content === 'string') return content.includes(needle)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.includes(needle)) return true
    }
  }
  return false
}

void path
