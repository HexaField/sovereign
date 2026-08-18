// OpenAI-compatible inference client for the local-llm backend.
// Self-contained — does not import from @sovereign/summary to avoid
// cross-package coupling.

/** Thrown when the inference server rejects a request because the prompt
 *  exceeds the configured context window (n_ctx). The tool loop catches
 *  this to trigger emergency compaction and retry. */
export class ContextOverflowError extends Error {
  readonly statusCode: number
  readonly serverMessage: string
  constructor(statusCode: number, serverMessage: string) {
    super(`Context overflow: prompt exceeds available context window (server returned ${statusCode})`)
    this.name = 'ContextOverflowError'
    this.statusCode = statusCode
    this.serverMessage = serverMessage
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface CompletionResponse {
  id: string
  choices: Array<{
    index: number
    message: ChatMessage
    finish_reason: 'stop' | 'tool_calls' | 'length' | null
  }>
  model: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface StreamChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      /** Models with thinking mode (Qwen3.6 etc.) may stream reasoning here
       *  instead of in `content`. The assembler merges it into content as a
       *  fallback so downstream code never loses output. */
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: 'stop' | 'tool_calls' | 'length' | null
  }>
  model: string
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface InferenceClientConfig {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs?: number
  /** When false, passes `chat_template_kwargs: { enable_thinking: false }` to
   *  the server. Saves output tokens on models that do chain-of-thought
   *  (Qwen3.6, etc.). Default true. */
  thinking?: boolean
}

export function createInferenceClient(initialConfig: InferenceClientConfig) {
  // Mutable state so hot-swap actually works.
  const state = { ...initialConfig }

  async function complete(
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    // Always stream internally to keep the TCP connection alive during
    // long generations. Collect chunks and assemble a CompletionResponse.
    const assembled = assembleEmpty()
    for await (const chunk of stream(messages, opts)) {
      assembleChunk(assembled, chunk)
    }
    return assembled.response
  }

  async function* stream(
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; signal?: AbortSignal }
  ): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: state.model,
      messages,
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: true,
      // Request usage stats in the final streaming chunk — without this,
      // the server omits prompt_tokens/completion_tokens and the backend
      // can't make accurate compaction decisions.
      stream_options: { include_usage: true }
    }
    if (opts?.tools?.length) {
      body.tools = opts.tools
      body.tool_choice = 'auto'
    }
    if (state.thinking === false) {
      body.chat_template_kwargs = { enable_thinking: false }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), state.timeoutMs ?? 600_000)
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      const url = `${state.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      // llama-server returns 500 when it fails to parse the model's tool
      // call arguments as JSON (e.g. truncated output hitting max_tokens).
      // Retry without the `tools` parameter so the server returns raw text
      // instead of crashing. Our parseToolCallsFromText() in tool-loop.ts
      // extracts valid <tool_call> tags from the text and skips malformed
      // ones — a graceful fallback the server-side parser lacks.
      if (!res.ok && body.tools) {
        const errText = await res.text().catch(() => '')
        if (errText.includes('exceed_context_size_error') || errText.includes('exceeds the available context size')) {
          // Context overflow — surface as a typed error so the tool loop
          // can trigger compaction and retry instead of dying.
          throw new ContextOverflowError(res.status, errText)
        }
        if (errText.includes('Failed to parse tool call arguments')) {
          const retryBody = { ...body }
          delete retryBody.tools
          delete retryBody.tool_choice
          res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(retryBody),
            signal: controller.signal
          })
        } else {
          throw new Error(`Inference stream failed: ${res.status} — ${errText}`)
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (text.includes('exceed_context_size_error') || text.includes('exceeds the available context size')) {
          throw new ContextOverflowError(res.status, text)
        }
        throw new Error(`Inference stream failed: ${res.status} — ${text}`)
      }
      if (!res.body) throw new Error('No response body for streaming request')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || trimmed === 'data: [DONE]') continue
          if (!trimmed.startsWith('data: ')) continue
          try {
            yield JSON.parse(trimmed.slice(6)) as StreamChunk
          } catch {
            /* skip malformed */
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Stream → CompletionResponse assembly ────────────────────────
  // Collects SSE chunks into a single non-streaming response shape.

  interface AssemblyState {
    response: CompletionResponse
    toolCalls: Map<number, ToolCall> // keyed by chunk.tool_calls[].index
  }

  function assembleEmpty(): AssemblyState {
    return {
      response: {
        id: '',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
        model: state.model
      },
      toolCalls: new Map()
    }
  }

  function assembleChunk(st: AssemblyState, chunk: StreamChunk): void {
    if (chunk.id) st.response.id = chunk.id
    if (chunk.model) st.response.model = chunk.model
    if (chunk.usage) st.response.usage = chunk.usage

    const delta = chunk.choices?.[0]?.delta
    if (!delta) return

    const msg = st.response.choices[0].message
    if (delta.role) msg.role = delta.role as ChatMessage['role']
    if (delta.content) msg.content = (msg.content ?? '') + delta.content
    // Fallback: merge reasoning_content into content when the model puts
    // output there (thinking mode enabled despite config). Without this,
    // text-only responses from thinking-mode models silently return empty.
    if (delta.reasoning_content && !delta.content) {
      msg.content = (msg.content ?? '') + delta.reasoning_content
    }

    // Accumulate tool calls by their stream index
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let existing = st.toolCalls.get(tc.index)
        if (!existing) {
          existing = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } }
          st.toolCalls.set(tc.index, existing)
        }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.function.name += tc.function.name
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
      }
    }

    const reason = chunk.choices?.[0]?.finish_reason
    if (reason) {
      st.response.choices[0].finish_reason = reason
      // Finalise tool_calls on the message
      if (st.toolCalls.size > 0) {
        msg.tool_calls = [...st.toolCalls.values()]
      }
    }
  }

  async function healthCheck(): Promise<boolean> {
    try {
      const url = `${state.baseUrl.replace(/\/+$/, '')}/v1/models`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  function updateConfig(patch: Partial<InferenceClientConfig>): void {
    Object.assign(state, patch)
  }

  return { complete, stream, healthCheck, updateConfig }
}

export type InferenceClient = ReturnType<typeof createInferenceClient>
