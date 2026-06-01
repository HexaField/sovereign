// Translates SDK message stream events into Sovereign AgentBackendEvents.
// Pure functions where possible; the adapter holds per-session bookkeeping
// (last-stream-length, thinking accumulator, seen-tool-call-ids) and passes
// it in.

import type { ParsedTurn, WorkItem } from '@sovereign/core'
import type { BackendEmitter } from '@sovereign/primitives'
import { stripThinkingBlocks } from '@sovereign/primitives'
import { classifyClaudeCodeTurn } from './classify.js'
import type { ClaudeSessionState, ClaudeUsage } from './types.js'

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

function blocksOf(message: any): ContentBlock[] {
  if (!message) return []
  if (Array.isArray(message)) return message as ContentBlock[]
  if (Array.isArray(message.content)) return message.content as ContentBlock[]
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return []
}

function joinText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('')
}

function joinThinking(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'thinking')
    .map((b) => (b.thinking ?? b.text ?? '') as string)
    .join('')
}

function toolUseBlocks(blocks: ContentBlock[]): Array<{ id: string; name: string; input: unknown }> {
  return blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} }))
}

function toolResultBlocks(blocks: ContentBlock[]): Array<{ toolCallId: string; content: unknown }> {
  return blocks
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({ toolCallId: b.tool_use_id ?? '', content: b.content ?? '' }))
}

function contentToOutputStr(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content as any[]) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b?.type === 'image' && typeof b.data === 'string') {
        const mime = b.mimeType ?? (b.data.startsWith('/9j/') ? 'image/jpeg' : 'image/png')
        parts.push(
          `<img src="data:${mime};base64,${b.data}" class="tool-screenshot" style="max-width:100%;height:auto;border-radius:4px;display:block;margin:4px 0;" />`
        )
      }
    }
    return parts.join('\n')
  }
  return content ? JSON.stringify(content) : ''
}

function flushThinking(state: ClaudeSessionState, emitter: BackendEmitter) {
  if (!state.thinkingAccum) return
  emitter.emit('chat.work', {
    sessionKey: state.sessionKey,
    work: { type: 'thinking', output: state.thinkingAccum, timestamp: Date.now() } as WorkItem
  })
  state.thinkingAccum = ''
}

/**
 * Move every text fragment we've accumulated so far in this round out of
 * `textAccum` and emit it as a `chat.work` thinking-style item.
 *
 * Called right before we emit a `tool_call` work item: by that point we
 * know any text seen so far was INTERMEDIATE NARRATION ("Let me check
 * that file.", "Now let me grep.") preceding a tool call, NOT the final
 * answer. The final answer is whatever text arrives AFTER all tool
 * calls in the round and stays in `textAccum` until `handleResult`
 * builds the `chat.turn` content from it.
 *
 * Without this flush, every intermediate narration in a multi-tool
 * round gets joined into the final agent bubble — visible in
 * production as a single bubble containing 4+ paragraphs of
 * "thinking-style" narration glued together where the user expects to
 * see only the agent's final answer.
 *
 * The intermediate narration still renders — but inside the collapsible
 * WorkSection between tool cards, which is where this content
 * semantically belongs.
 */
function flushTextAccumAsNarration(state: ClaudeSessionState, emitter: BackendEmitter): void {
  if (state.textAccum.length === 0) return
  const narration = state.textAccum.join('\n\n')
  emitter.emit('chat.work', {
    sessionKey: state.sessionKey,
    work: { type: 'thinking', output: narration, timestamp: Date.now() } as WorkItem
  })
  state.textAccum = []
}

function setWorking(state: ClaudeSessionState, emitter: BackendEmitter) {
  if (state.agentStatus === 'working') return
  state.agentStatus = 'working'
  emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'working' })
}

function setIdle(state: ClaudeSessionState, emitter: BackendEmitter) {
  if (state.agentStatus === 'idle') return
  state.agentStatus = 'idle'
  emitter.emit('chat.status', { sessionKey: state.sessionKey, status: 'idle' })
}

/**
 * True iff a Claude Agent SDK message originated inside a subagent. Per
 * @anthropic-ai/claude-agent-sdk SDKAssistantMessage / SDKUserMessage:
 * every message emitted from a subagent carries `parent_tool_use_id`
 * set to the spawning tool's id (`null` for the main thread).
 *
 * The SDK forwards subagent tool_use / tool_result blocks to the parent
 * stream by default (forwardSubagentText:false) — enough for a heartbeat
 * counter — and with forwardSubagentText:true it also forwards text and
 * thinking. NONE of these belong on the parent's chat.stream / chat.work
 * / chat.turn surface: they would render the child's tool calls in the
 * parent's collapsible tool list and (under forwardSubagentText:true)
 * splice the child's narration into the parent's final assistant bubble.
 *
 * The subagent's own activity surfaces independently via the
 * SubagentStart / SubagentStop hooks (see claude-code.ts) which feed the
 * subagent.* bus events and the SubagentCard UI.
 */
function isSubagentMessage(msg: any): boolean {
  return msg?.parent_tool_use_id != null
}

/**
 * Handle a full (non-partial) assistant message — emits incremental
 * `chat.stream` (relative to whatever we'd already streamed), tool_call work
 * items, and accumulates thinking. The final turn is emitted by `handleResult`.
 */
export function handleAssistantMessage(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  if (isSubagentMessage(msg)) return
  setWorking(state, emitter)
  const blocks = blocksOf(msg.message)
  const text = stripThinkingBlocks(joinText(blocks))
  // Each SDKAssistantMessage carries its own complete text — NOT a
  // cumulative running buffer — because we run with
  // `includePartialMessages:false` (see claude-code.ts startSessionLoop).
  // The previous logic compared `text.length` against a streamLastLength
  // that persisted across messages within a round, which produced
  // wrong-tail deltas when a later message's text was longer than an
  // earlier one and missed emissions when shorter. Dedup the message by
  // string match against the last accumulated fragment instead — that
  // both prevents duplicates on resume / redelivery and keeps every
  // delta a clean self-contained fragment.
  const trimmed = text.trim()
  if (trimmed) {
    const lastFragment = state.textAccum[state.textAccum.length - 1]
    if (lastFragment !== trimmed) {
      // \n\n separator between rounds of intermediate narration so the
      // streaming view matches the joined chat.turn content reconstructed
      // from textAccum in handleResult.
      const prefix = state.textAccum.length === 0 ? '' : '\n\n'
      emitter.emit('chat.stream', { sessionKey: state.sessionKey, text: prefix + text })
      state.textAccum.push(trimmed)
    }
  }
  // Keep streamLastLength updated for any downstream code that might
  // still read it (write-through persistence schema, telemetry) — but
  // never use it as a gate. Set to the cumulative joined-length of what
  // we've emitted so post-restart resume keeps a sensible snapshot.
  state.streamLastLength = state.textAccum.join('\n\n').length
  const thinking = joinThinking(blocks)
  if (thinking) {
    if (thinking.length > state.thinkingAccum.length) state.thinkingAccum = thinking
    emitter.emit('chat.work', {
      sessionKey: state.sessionKey,
      work: { type: 'thinking', output: state.thinkingAccum, timestamp: Date.now() } as WorkItem
    })
  }
  for (const tc of toolUseBlocks(blocks)) {
    flushThinking(state, emitter)
    // Whatever text we've accumulated so far in this round is
    // intermediate narration before this tool call — move it into the
    // work section so the final chat.turn doesn't render it as part of
    // the agent's final answer. See `flushTextAccumAsNarration`.
    flushTextAccumAsNarration(state, emitter)
    const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {})
    emitter.emit('chat.work', {
      sessionKey: state.sessionKey,
      work: {
        type: 'tool_call',
        name: tc.name,
        input: inputStr,
        toolCallId: tc.id,
        timestamp: Date.now()
      } as WorkItem
    })
  }
}

/**
 * Handle a user message arriving in the SDK stream — this happens after a
 * tool completes (the SDK echoes the user-role tool_result). We surface tool
 * results from those blocks.
 */
export function handleSdkUserMessage(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  if (isSubagentMessage(msg)) return
  const blocks = blocksOf(msg.message)
  for (const tr of toolResultBlocks(blocks)) {
    if (!tr.toolCallId) continue
    emitter.emit('chat.work', {
      sessionKey: state.sessionKey,
      work: {
        type: 'tool_result',
        output: contentToOutputStr(tr.content),
        toolCallId: tr.toolCallId,
        timestamp: Date.now()
      } as WorkItem
    })
  }
}

/**
 * Handle an `SDKResultMessage` — terminal message for a turn. Emits the
 * final `chat.turn` + status=idle.
 */
export function handleResult(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  flushThinking(state, emitter)
  // Prefer the accumulated text fragments — they include every intermediate
  // narration ("About to run X.") between tool calls. msg.result is only the
  // final fragment, which would make the live chat.turn diverge from what the
  // JSONL parser produces on reload. Fall back to msg.result if accumulator
  // is empty (rare: agents that emit nothing during a round).
  const resultFallback = stripThinkingBlocks((msg?.result ?? '').toString().trim())
  const joined = state.textAccum
    .map((s) => stripThinkingBlocks(s).trim())
    .filter(Boolean)
    .join('\n\n')
  const finalContent = joined || resultFallback
  const turn: ParsedTurn = classifyClaudeCodeTurn({
    role: 'assistant',
    content: finalContent,
    timestamp: Date.now(),
    workItems: [],
    thinkingBlocks: []
  })
  if (turn.content || msg?.subtype === 'error') {
    emitter.emit('chat.turn', { sessionKey: state.sessionKey, turn })
  }
  // Capture usage.
  if (msg?.usage) {
    state.lastUsage = {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadInputTokens: msg.usage.cache_read_input_tokens,
      cacheCreationInputTokens: msg.usage.cache_creation_input_tokens,
      totalCostUsd: msg.total_cost_usd
    } satisfies ClaudeUsage
  }
  if (msg?.subtype === 'error' || msg?.is_error) {
    const reason =
      msg?.message ?? msg?.error ?? (msg?.api_error_status ? `API error ${msg.api_error_status}` : 'Agent error')
    emitter.emit('chat.error', {
      sessionKey: state.sessionKey,
      error: typeof reason === 'string' ? reason : JSON.stringify(reason)
    })
  }
  setIdle(state, emitter)
  state.streamLastLength = 0
  state.textAccum = []
}

/** Handle compaction boundary system messages. */
export function handleCompactBoundary(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  // The SDK only emits one boundary message — start + end happen at the same
  // point because compaction is synchronous. Emit both quickly so any UI
  // subscribed to `chat.compacting` flickers off correctly.
  emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: true })
  emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: false })
  // Surface the chip as a system turn so it appears in the transcript even
  // when the user hasn't reloaded history.
  const meta = msg?.compact_metadata ?? {}
  const pre = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : null
  const post = typeof meta.post_tokens === 'number' ? meta.post_tokens : null
  const trigger = meta.trigger ?? 'auto'
  const parts: string[] = ['⚙️ Compacted']
  if (pre != null && post != null) parts.push(`(${pre} → ${post} tokens, ${trigger})`)
  else if (trigger) parts.push(`(${trigger})`)
  emitter.emit('chat.turn', {
    sessionKey: state.sessionKey,
    turn: classifyClaudeCodeTurn({
      role: 'system',
      content: parts.join(' '),
      timestamp: Date.now(),
      workItems: [],
      thinkingBlocks: []
    })
  })
}

/** Handle SDKStatusMessage (subtype 'status') — propagate compacting state. */
export function handleStatus(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  if (msg?.status === 'compacting') {
    emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: true })
  } else if (msg?.compact_result === 'success' || msg?.compact_result === 'failed') {
    emitter.emit('chat.compacting', { sessionKey: state.sessionKey, active: false })
  }
}

/** Dispatch any SDK message to the right handler. */
export function dispatchSdkMessage(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'assistant':
      handleAssistantMessage(msg, state, emitter)
      return
    case 'user':
      handleSdkUserMessage(msg, state, emitter)
      return
    case 'result':
      handleResult(msg, state, emitter)
      return
    case 'system':
      if (msg.subtype === 'compact_boundary') handleCompactBoundary(msg, state, emitter)
      else if (msg.subtype === 'status') handleStatus(msg, state, emitter)
      else if (msg.subtype === 'session_state_changed') {
        if (msg.state === 'idle') setIdle(state, emitter)
        else if (msg.state === 'running') setWorking(state, emitter)
      }
      return
  }
}
