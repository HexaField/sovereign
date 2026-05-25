// Translates SDK message stream events into Sovereign AgentBackendEvents.
// Pure functions where possible; the adapter holds per-session bookkeeping
// (last-stream-length, thinking accumulator, seen-tool-call-ids) and passes
// it in.

import type { ParsedTurn, WorkItem } from '@sovereign/core'
import type { BackendEmitter } from '@sovereign/primitives'
import { stripThinkingBlocks } from '@sovereign/primitives'
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
 * Handle a full (non-partial) assistant message — emits incremental
 * `chat.stream` (relative to whatever we'd already streamed), tool_call work
 * items, and accumulates thinking. The final turn is emitted by `handleResult`.
 */
export function handleAssistantMessage(msg: any, state: ClaudeSessionState, emitter: BackendEmitter): void {
  setWorking(state, emitter)
  const blocks = blocksOf(msg.message)
  const text = stripThinkingBlocks(joinText(blocks))
  if (text.length > state.streamLastLength) {
    const delta = text.slice(state.streamLastLength)
    state.streamLastLength = text.length
    if (delta) emitter.emit('chat.stream', { sessionKey: state.sessionKey, text: delta })
  }
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
  const cleaned = (msg?.result ?? '').toString().trim()
  const turn: ParsedTurn = {
    role: 'assistant',
    content: stripThinkingBlocks(cleaned),
    timestamp: Date.now(),
    workItems: [],
    thinkingBlocks: []
  }
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
    turn: {
      role: 'system',
      content: parts.join(' '),
      timestamp: Date.now(),
      workItems: [],
      thinkingBlocks: []
    }
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
