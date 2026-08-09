// Tool-calling loop — sends messages to the inference server, executes tool
// calls, feeds results back, repeats until the model stops calling tools.
// Emits Sovereign AgentBackendEvents throughout so the UI sees live
// tool_call/tool_result activity while the loop runs, not just the final
// answer.

import { randomUUID } from 'node:crypto'
import type { AgentBackendEvents, WorkItem } from '@sovereign/core'
import type { ChatMessage as WireChatMessage, CompletionResponse, ToolSchema } from './inference.js'
import type { ToolResult } from './tools/index.js'

/**
 * A chat message as stored in a local-llm session: the OpenAI wire shape
 * plus a `timestamp`, used to reconstruct ParsedTurn history from the
 * persisted transcript (see `toGenericMessages` in local-llm.ts). Strip
 * `timestamp` before sending a message array over the wire.
 */
export interface ChatMessage extends WireChatMessage {
  timestamp: number
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
  /** Tool schemas to send with each request. */
  toolSchemas: ToolSchema[]
  /** Maximum loop iterations (prevent infinite tool loops). */
  maxIterations?: number
}

export interface ToolLoopResult {
  /** The full message array — `messages`, mutated in place and returned for convenience. */
  messages: ChatMessage[]
  /** The last non-empty assistant text seen — the turn's final answer. */
  finalContent: string
  /** Tool calls executed across the whole loop. Lets the caller decide
   *  whether an otherwise textless final turn is still worth surfacing. */
  toolCallCount: number
}

const DEFAULT_MAX_ITERATIONS = 20

// Local models typically run with small context windows (32k tokens by
// default) — an unbounded tool result (e.g. Bash `cat` on a large file) fed
// straight back into the transcript can blow the window in a single round
// trip. Cap what goes back to the model; the live `chat.work` event carries
// the output up to its own (larger) cap for the UI.
const MAX_TOOL_RESULT_CHARS_FOR_MODEL = 8_000
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

  while (iterations < maxIter) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    iterations++

    const response = await deps.complete(messages, { tools: deps.toolSchemas, signal })
    const choice = response.choices?.[0]
    if (!choice) break

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: choice.message?.content ?? null,
      // Normalize missing ids here — on the assistant message itself, not
      // just the tool-result reply — so a server that omits tool_call.id
      // still produces a transcript where the assistant's tool_calls[].id
      // and the matching tool message's tool_call_id always agree. Sending
      // the model back a tool result whose id doesn't match any tool_call
      // it just made is invalid per the OpenAI tool-calling contract and
      // has caused real servers to error or hallucinate on the next turn.
      tool_calls: choice.message?.tool_calls?.map((tc) => ({ ...tc, id: tc.id || randomUUID() })),
      timestamp: Date.now()
    }
    messages.push(assistantMsg)

    if (assistantMsg.content) {
      finalContent = assistantMsg.content
      deps.emit('chat.stream', { sessionKey, text: assistantMsg.content })
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
  }

  if (iterations >= maxIter) {
    deps.emit('chat.error', {
      sessionKey,
      error: `Tool loop reached the maximum of ${maxIter} iterations without a final answer.`
    })
  }

  return { messages, finalContent, toolCallCount }
}
