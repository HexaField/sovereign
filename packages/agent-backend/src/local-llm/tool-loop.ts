// Tool-calling loop — sends messages to the inference server, executes tool
// calls, feeds results back, repeats until the model stops calling tools.
// Emits Sovereign AgentBackendEvents throughout so the UI sees live
// tool_call/tool_result/thinking activity while the loop runs.

import { randomUUID } from 'node:crypto'
import type { AgentBackendEvents, WorkItem } from '@sovereign/core'
import {
  ContextOverflowError,
  type ChatMessage as WireChatMessage,
  type CompletionResponse,
  type ToolSchema
} from './inference.js'
import type { ToolResult } from './tools/index.js'

/**
 * A chat message as stored in a local-llm session: the OpenAI wire shape
 * plus local-only fields (`timestamp`, `reasoning`) used to reconstruct
 * ParsedTurn history from the persisted transcript.
 *
 * Strip `timestamp` and `reasoning` before sending over the wire via
 * `toWireMessages` in local-llm.ts.
 */
export interface ChatMessage extends WireChatMessage {
  timestamp: number
  /** Reasoning/thinking content produced alongside this assistant message.
   *  Local-only — never sent on the wire. Stored so the caller can populate
   *  ParsedTurn.thinkingBlocks from history and emit chat.work thinking events. */
  reasoning?: string
}

export interface ToolLoopDeps {
  /** Sends a chat completion request, returns the full response. */
  complete: (
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; signal?: AbortSignal }
  ) => Promise<CompletionResponse>
  /** Executes a tool by name. */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>
  /** Emit a Sovereign backend event. */
  emit: <K extends keyof AgentBackendEvents>(event: K, data: AgentBackendEvents[K]) => void
  /** Tool schemas to send with each request. When `getActiveSchemas` is set,
   *  this serves as the initial/fallback set only. */
  toolSchemas: ToolSchema[]
  /** Maximum loop iterations (prevent infinite tool loops). */
  maxIterations?: number
  /** Progressive tool disclosure — returns the currently active schema set
   *  (core + any schemas loaded via ToolSearch). When set, the tool loop
   *  calls this on each iteration instead of using the static `toolSchemas`. */
  getActiveSchemas?: () => ToolSchema[]
  /** Called between iterations with the server-reported prompt token count
   *  and the loop's messages array. The caller can modify messages in place
   *  (e.g. compact older messages into a summary) to stay within context. */
  onIterationEnd?: (promptTokens: number, messages: ChatMessage[]) => Promise<void>
  /** Called when the server rejects a request due to context overflow.
   *  The callback must compact messages in place to reduce context size.
   *  Returns true when compaction succeeded and the loop should retry. */
  onContextOverflow?: (messages: ChatMessage[]) => Promise<boolean>
  /** Called when a completion produces reasoning/thinking content.
   *  Receives the full reasoning block for the current iteration.
   *  The tool loop also emits a chat.work thinking event automatically —
   *  this callback is for callers that want to accumulate blocks separately
   *  (e.g. to populate ParsedTurn.thinkingBlocks on the final turn). */
  onThinking?: (content: string) => void
}

export interface ToolLoopResult {
  /** The full message array — `messages`, mutated in place and returned for convenience. */
  messages: ChatMessage[]
  /** The last non-empty assistant text seen — the turn's final answer. */
  finalContent: string
  /** Tool calls executed across the whole loop. Lets the caller decide
   *  whether an otherwise textless final turn is still worth surfacing. */
  toolCallCount: number
  /** Last server-reported prompt token count — the most accurate measure
   *  of actual context usage. Used by the caller for compaction decisions. */
  lastPromptTokens?: number
}

const DEFAULT_MAX_ITERATIONS = 50

// Local models typically run with small context windows (32k tokens by
// default) — an unbounded tool result (e.g. Bash `cat` on a large file) fed
// straight back into the transcript can blow the window in a single round
// trip. Cap what goes back to the model; the live `chat.work` event carries
// the output up to its own (larger) cap for the UI.
const MAX_TOOL_RESULT_CHARS_FOR_MODEL = 48_000
const MAX_TOOL_RESULT_CHARS_FOR_UI = 4_000

function truncateForModel(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS_FOR_MODEL) return text
  const cut = text.length - MAX_TOOL_RESULT_CHARS_FOR_MODEL
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS_FOR_MODEL)}\n\n[truncated — ${cut} more characters]`
}

/** Parse a tool call's `function.arguments` (JSON string, or occasionally
 *  an already-parsed object from more lenient servers) into a plain object. */
function parseToolArguments(rawArgs: unknown): { input: Record<string, unknown>; error?: string } {
  if (rawArgs == null) return { input: {} }
  if (typeof rawArgs === 'object') return { input: rawArgs as Record<string, unknown> }
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    if (!trimmed) return { input: {} }
    try {
      const parsed = JSON.parse(trimmed)
      return { input: (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown> }
    } catch (err) {
      return {
        input: {},
        error: `Failed to parse tool arguments as JSON: ${(err as Error).message}. Raw arguments: ${trimmed.slice(0, 300)}`
      }
    }
  }
  return { input: {} }
}

/** Parse `<tool_call>...</tool_call>` XML tags from model text output.
 *  Many local models (Qwen3, Llama 3.x, Hermes) emit tool calls as
 *  structured text rather than populating the OpenAI `tool_calls` array.
 *  This fallback extracts those calls so the loop works regardless of
 *  whether the model server does server-side parsing. */
function parseToolCallsFromText(
  text: string
): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | undefined {
  const TAG_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g
  const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed.name === 'string') {
        const args = parsed.arguments ?? parsed.parameters ?? {}
        calls.push({
          id: randomUUID(),
          type: 'function',
          function: {
            name: parsed.name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args)
          }
        })
      }
    } catch {
      /* malformed JSON inside tag — skip */
    }
  }
  return calls.length > 0 ? calls : undefined
}

/** Extract `<think>...</think>` blocks from model content text, returning
 *  the thinking text and the content with those blocks removed.
 *
 *  Some servers (particularly llama.cpp with --reasoning off but thinking
 *  jinja template active) embed thinking directly in the content stream
 *  rather than emitting separate reasoning-delta events. This extracts
 *  those blocks before they get stripped by stripModelMetaTags, so the
 *  thinking content reaches the chat.work event. */
function extractEmbeddedThinking(text: string): { thinking: string; content: string } {
  let thinking = ''
  let content = text
  const THINK_RE = /<think>([\s\S]*?)<\/think>/g
  let match: RegExpExecArray | null
  const parts: string[] = []
  let lastIndex = 0
  while ((match = THINK_RE.exec(text)) !== null) {
    parts.push(text.slice(lastIndex, match.index))
    thinking += (thinking ? '\n' : '') + match[1].trim()
    lastIndex = match.index + match[0].length
  }
  if (thinking) {
    parts.push(text.slice(lastIndex))
    content = parts.join('').trim()
  }
  return { thinking, content }
}

/** Strip `<think>...</think>` blocks and `<tool_call>` tags from text,
 *  returning only the user-facing content. Models that do chain-of-thought
 *  (Qwen3 etc.) wrap reasoning in `<think>` tags — remove those so the
 *  final answer shown to the user stays clean. */
function stripModelMetaTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/g, '')
    .trim()
}

export async function runToolLoop(
  sessionKey: string,
  messages: ChatMessage[],
  deps: ToolLoopDeps,
  signal?: AbortSignal
): Promise<ToolLoopResult> {
  const maxIter = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS
  let iterations = 0
  let finalContent = ''
  let toolCallCount = 0
  let lastPromptTokens: number | undefined

  while (iterations < maxIter) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    iterations++

    // Progressive tool disclosure: use dynamically expanded schemas when
    // available, falling back to the static set.
    const activeTools = deps.getActiveSchemas ? deps.getActiveSchemas() : deps.toolSchemas
    let response: CompletionResponse
    try {
      response = await deps.complete(messages, { tools: activeTools, signal })
    } catch (err) {
      if (err instanceof ContextOverflowError && deps.onContextOverflow) {
        deps.emit('chat.error', {
          sessionKey,
          error: `Context overflow detected — triggering emergency compaction`
        })
        const compacted = await deps.onContextOverflow(messages)
        if (compacted) {
          // Retry this iteration after compaction shrank the transcript
          iterations--
          continue
        }
      }
      throw err
    }
    const choice = response.choices?.[0]
    if (!choice) break

    // Track server-reported prompt tokens for accurate compaction decisions
    if (response.usage?.prompt_tokens) {
      lastPromptTokens = response.usage.prompt_tokens
    }

    // ── Thinking / reasoning content ────────────────────────────────
    // Combine API-level reasoning (from reasoning-delta events) with any
    // <think> blocks embedded in the content stream (for servers that
    // don't separate them). Emit a thinking work item so the UI renders
    // it alongside tool calls.

    const rawContent = choice.message?.content ?? null

    // Extract <think> blocks from content BEFORE stripping (so we capture them)
    const { thinking: embeddedThinking, content: contentWithoutThink } = rawContent
      ? extractEmbeddedThinking(rawContent)
      : { thinking: '', content: '' }

    // Merge API reasoning + embedded thinking into one block
    const fullReasoning = [response.reasoning, embeddedThinking].filter(Boolean).join('\n').trim()

    if (fullReasoning) {
      // Notify caller so it can accumulate thinking blocks per-turn
      deps.onThinking?.(fullReasoning)

      deps.emit('chat.work', {
        sessionKey,
        work: {
          type: 'thinking',
          output: fullReasoning.slice(0, MAX_TOOL_RESULT_CHARS_FOR_UI),
          timestamp: Date.now()
        } as WorkItem
      })
    }

    // Determine tool calls: prefer the structured `tool_calls` array from
    // the server, but fall back to parsing `<tool_call>` tags from the
    // text content when the server doesn't do its own extraction.
    let resolvedToolCalls = choice.message?.tool_calls?.map((tc) => ({
      ...tc,
      id: tc.id || randomUUID()
    }))

    // Use content-without-think for tool call parsing (think blocks already removed)
    const rawContentForTools = contentWithoutThink || rawContent
    if ((!resolvedToolCalls || resolvedToolCalls.length === 0) && rawContentForTools) {
      resolvedToolCalls = parseToolCallsFromText(rawContentForTools)
    }

    // Strip remaining meta tags (tool_call tags) from user-facing content
    const cleanContent = contentWithoutThink ? stripModelMetaTags(contentWithoutThink) : null

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: cleanContent,
      tool_calls: resolvedToolCalls,
      // Store reasoning for history reconstruction (populates thinkingBlocks)
      reasoning: fullReasoning || undefined,
      timestamp: Date.now()
    }
    messages.push(assistantMsg)

    if (cleanContent) {
      finalContent = cleanContent
      deps.emit('chat.stream', { sessionKey, text: cleanContent })
    }

    const toolCalls = assistantMsg.tool_calls
    // Lenient by design: several llama.cpp / ollama / vLLM builds don't set
    // finish_reason: 'tool_calls' correctly even when tool_calls IS present.
    // Trust the presence of tool_calls over finish_reason for cross-server
    // compatibility rather than gating on finish_reason.
    if (!toolCalls || toolCalls.length === 0) break

    for (const toolCall of toolCalls) {
      toolCallCount++
      const fnName = toolCall.function?.name ?? ''
      const toolCallId = toolCall.id // already normalized to a non-empty id above
      const { input, error: parseError } = parseToolArguments(toolCall.function?.arguments)

      deps.emit('chat.work', {
        sessionKey,
        work: {
          type: 'tool_call',
          toolCallId,
          name: fnName,
          input: parseError ? String(toolCall.function?.arguments ?? '') : JSON.stringify(input),
          timestamp: Date.now()
        } as WorkItem
      })

      const result: ToolResult = parseError ? { content: '', error: parseError } : await deps.executeTool(fnName, input)
      const outputText = result.error
        ? `Error: ${result.error}${result.content ? `\n${result.content}` : ''}`
        : result.content

      deps.emit('chat.work', {
        sessionKey,
        work: {
          type: 'tool_result',
          toolCallId,
          name: fnName,
          output: outputText.slice(0, MAX_TOOL_RESULT_CHARS_FOR_UI),
          timestamp: Date.now()
        } as WorkItem
      })

      messages.push({
        role: 'tool',
        name: fnName,
        content: truncateForModel(outputText),
        tool_call_id: toolCallId,
        timestamp: Date.now()
      })
    }

    // Between iterations: let the caller compact if context grew too large.
    // This prevents single-turn tool loops from blowing past the context
    // window without triggering compaction (which otherwise only fires
    // between sendMessage calls).
    if (deps.onIterationEnd && lastPromptTokens) {
      await deps.onIterationEnd(lastPromptTokens, messages)
    }
  }

  if (iterations >= maxIter) {
    // Force a synthesis turn — one final no-tools completion so the user
    // always gets an answer instead of silence when the loop hits its cap.
    // Best-effort: if the synthesis fails, the error still fires below.
    try {
      messages.push({
        role: 'system',
        content:
          'You have reached the maximum number of tool calls for this turn. ' +
          'Write a concise summary of what you accomplished and any remaining work. ' +
          'Do not call any more tools.',
        timestamp: Date.now()
      })
      if (!signal?.aborted) {
        const synthesis = await deps.complete(messages, { signal })
        const synText = synthesis.choices?.[0]?.message?.content
        if (synText) {
          const clean = stripModelMetaTags(synText)
          if (clean) {
            finalContent = clean
            deps.emit('chat.stream', { sessionKey, text: clean })
            messages.push({
              role: 'assistant',
              content: clean,
              reasoning: synthesis.reasoning,
              timestamp: Date.now()
            })
          }
        }
      }
    } catch {
      /* synthesis failed — fall through to error event */
    }

    deps.emit('chat.error', {
      sessionKey,
      error: `Tool loop reached the maximum of ${maxIter} iterations without a final answer.`
    })
  }

  return { messages, finalContent, toolCallCount, lastPromptTokens }
}
