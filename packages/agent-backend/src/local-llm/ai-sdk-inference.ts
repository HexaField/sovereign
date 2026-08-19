// AI SDK-backed inference client for the local-llm backend.
//
// Drop-in replacement for createInferenceClient — same external API
// (complete, healthCheck, updateConfig) but uses the Vercel AI SDK
// v7 internally. The tool loop, progressive disclosure, and all downstream
// code remain unchanged.
//
// Uses streamText (not generateText) to keep the TCP connection alive
// during long generations — same keep-alive strategy as the original
// SSE-based client.
//
// Custom fetch layer handles:
//   - chat_template_kwargs injection (thinking mode control)
//   - ContextOverflowError detection (before AI SDK retries)
//   - Tool parse failure detection (retry without tools)
//   - Transient connection retry with health check

import { streamText, jsonSchema, tool as aiTool } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelMessage, ToolSet } from 'ai'
import { ContextOverflowError } from './inference.js'
import type { ChatMessage, CompletionResponse, InferenceClientConfig, ToolCall, ToolSchema } from './inference.js'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 2000

/** Internal error for tool parse failures — caught at complete() to retry
 *  without tools (same as the raw-fetch client's fallback). */
class ToolParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolParseError'
  }
}

// ── Message format conversion ────────────────────────────────────────

/** Extract system messages and convert the rest to AI SDK ModelMessage[].
 *  System messages merge into a single `system` parameter for streamText —
 *  avoids the multi-system-message issue with model templates. */
function toModelMessages(messages: ChatMessage[]): { system: string; core: ModelMessage[] } {
  const systemParts: string[] = []
  const core: ModelMessage[] = []

  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      continue
    }

    if (m.role === 'user') {
      core.push({ role: 'user', content: m.content ?? '' } as ModelMessage)
      continue
    }

    if (m.role === 'assistant') {
      const parts: Array<
        { type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      if (m.content) parts.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = {}
        }
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input
        })
      }
      // AI SDK requires non-empty content
      if (parts.length === 0) parts.push({ type: 'text', text: '' })
      core.push({ role: 'assistant', content: parts } as ModelMessage)
      continue
    }

    if (m.role === 'tool') {
      core.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id ?? '',
            toolName: m.name ?? '',
            output: { type: 'text' as const, value: m.content ?? '' }
          }
        ]
      } as ModelMessage)
    }
  }

  return { system: systemParts.join('\n\n'), core }
}

// ── Tool schema conversion ───────────────────────────────────────────

/** Convert our OpenAI-shaped ToolSchema[] to AI SDK ToolSet.
 *  Tools have no execute function — the AI SDK returns tool call data
 *  without executing, and our tool loop handles execution. This preserves
 *  progressive disclosure. */
function toAiSdkTools(schemas: ToolSchema[]): ToolSet {
  const tools: ToolSet = {}
  for (const schema of schemas) {
    const fn = schema.function
    tools[fn.name] = aiTool({
      description: fn.description,
      inputSchema: jsonSchema(fn.parameters as any)
      // No execute — client-side tool
    })
  }
  return tools
}

// ── Client factory ───────────────────────────────────────────────────

export function createAiSdkInferenceClient(initialConfig: InferenceClientConfig) {
  const state = { ...initialConfig }

  async function healthCheck(): Promise<boolean> {
    try {
      const url = `${state.baseUrl.replace(/\/+$/, '')}/v1/models`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** Custom fetch that handles thinking-mode injection, server-specific
   *  errors, and transient connection retries. */
  function createCustomFetch(): typeof globalThis.fetch {
    return async function customFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      // Inject chat_template_kwargs for thinking mode control.
      // llama.cpp uses this non-standard field to toggle chain-of-thought.
      if (state.thinking === false && init?.body && typeof init.body === 'string') {
        try {
          const body = JSON.parse(init.body)
          body.chat_template_kwargs = { enable_thinking: false }
          init = { ...init, body: JSON.stringify(body) }
        } catch {
          /* non-JSON body — pass through */
        }
      }

      let lastError: unknown
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1)
          console.warn(`[ai-sdk] fetch retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`)
          await new Promise((r) => setTimeout(r, delay))
          const healthy = await healthCheck()
          if (!healthy) {
            console.warn('[ai-sdk] inference server unreachable, aborting retry')
            throw lastError
          }
        }

        try {
          const res = await globalThis.fetch(url, init)

          if (!res.ok) {
            // Read body to check for server-specific errors.
            // Reconstruct the Response for the AI SDK if generic.
            const text = await res.text()

            if (text.includes('exceed_context_size_error') || text.includes('exceeds the available context size')) {
              throw new ContextOverflowError(res.status, text)
            }

            if (text.includes('Failed to parse tool call arguments')) {
              throw new ToolParseError(text)
            }

            // Reconstruct response so the AI SDK can handle the error
            return new Response(text, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers
            })
          }

          return res
        } catch (err) {
          lastError = err
          // Don't retry our domain-specific errors
          if (err instanceof ContextOverflowError || err instanceof ToolParseError) throw err
          // Only retry transient TCP/connection failures
          const isTransient =
            err instanceof TypeError && /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(err.message)
          if (!isTransient || attempt === MAX_RETRIES) throw err
        }
      }
      // Unreachable — loop always throws on final attempt
      throw lastError
    }
  }

  function getProvider() {
    return createOpenAICompatible({
      name: 'local-llm',
      baseURL: state.baseUrl.replace(/\/+$/, '') + '/v1',
      fetch: createCustomFetch()
    })
  }

  /** Send messages and collect the streamed response into a CompletionResponse.
   *  On ToolParseError, retries without tools (the model returns raw text
   *  and our parseToolCallsFromText in tool-loop.ts extracts valid calls). */
  async function complete(
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    try {
      return await doStreamAndCollect(messages, opts)
    } catch (err) {
      if (err instanceof ToolParseError && opts?.tools?.length) {
        // Retry without tools — same fallback as the raw-fetch client
        return await doStreamAndCollect(messages, { ...opts, tools: undefined })
      }
      throw err
    }
  }

  async function doStreamAndCollect(
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const { system, core } = toModelMessages(messages)
    const tools = opts?.tools?.length ? toAiSdkTools(opts.tools) : undefined

    const stream = streamText({
      model: getProvider().chatModel(state.model),
      system: system || undefined,
      messages: core,
      tools,
      toolChoice: tools ? 'auto' : undefined,
      // v7 default stopWhen is isStepCount(1) — single inference call.
      // Our tool loop handles iteration, so the default works perfectly.
      maxRetries: 0, // retries handled in custom fetch
      temperature: state.temperature,
      maxOutputTokens: state.maxTokens,
      abortSignal: opts?.signal
    })

    // Collect stream parts — keeps the TCP connection alive during long
    // generations (same keep-alive strategy as the raw SSE client).
    let text = ''
    let reasoning = ''
    const toolCalls: ToolCall[] = []
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
    let finishReason = 'stop'

    for await (const part of stream.fullStream) {
      switch (part.type) {
        case 'text-delta':
          text += (part as any).text ?? ''
          break
        case 'reasoning-delta':
          reasoning += (part as any).text ?? ''
          break
        case 'tool-call':
          toolCalls.push({
            id: (part as any).toolCallId ?? '',
            type: 'function',
            function: {
              name: (part as any).toolName ?? '',
              arguments:
                typeof (part as any).input === 'string'
                  ? (part as any).input
                  : JSON.stringify((part as any).input ?? {})
            }
          })
          break
        case 'finish-step':
          usage = (part as any).usage
          finishReason = (part as any).finishReason ?? 'stop'
          break
        case 'finish':
          // Final event — capture usage if finish-step didn't provide it
          if (!usage && (part as any).totalUsage) usage = (part as any).totalUsage
          if ((part as any).finishReason) finishReason = (part as any).finishReason
          break
      }
    }

    // Merge reasoning into text when the model only produces reasoning
    // content (thinking mode enabled, Qwen3.x puts output in reasoning_content).
    // Without this, text-only responses from thinking-mode models appear empty.
    if (!text && reasoning) text = reasoning

    const mappedFinishReason: 'stop' | 'tool_calls' | 'length' | null =
      toolCalls.length > 0
        ? 'tool_calls'
        : finishReason === 'stop'
          ? 'stop'
          : finishReason === 'length'
            ? 'length'
            : null

    return {
      id: '',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
          },
          finish_reason: mappedFinishReason
        }
      ],
      model: state.model,
      usage: usage
        ? {
            prompt_tokens: (usage as any).inputTokens ?? 0,
            completion_tokens: (usage as any).outputTokens ?? 0,
            total_tokens: (usage as any).totalTokens ?? 0
          }
        : undefined
    }
  }

  function updateConfig(patch: Partial<InferenceClientConfig>): void {
    Object.assign(state, patch)
  }

  return { complete, healthCheck, updateConfig }
}
