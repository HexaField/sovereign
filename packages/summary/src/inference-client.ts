// OpenAI-compatible inference client — shared by the summary service
// and the local-llm agent backend.

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

export interface CompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  tools?: ToolSchema[]
  tool_choice?: 'auto' | 'none' | 'required'
  stream?: boolean
}

export interface CompletionChoice {
  index: number
  message: ChatMessage
  finish_reason: 'stop' | 'tool_calls' | 'length' | null
}

export interface CompletionResponse {
  id: string
  choices: CompletionChoice[]
  model: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface StreamDelta {
  role?: string
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

export interface StreamChunk {
  id: string
  choices: Array<{
    index: number
    delta: StreamDelta
    finish_reason: 'stop' | 'tool_calls' | 'length' | null
  }>
  model: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface InferenceClientConfig {
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
  /** Request timeout in ms. Default: 60000. */
  timeoutMs?: number
}

/**
 * Fully-resolved config with defaults applied. Held as a single mutable
 * object so `updateConfig` can hot-swap values that every in-flight and
 * future call reads from — a plain destructure into `const`s would freeze
 * the values at construction time and silently break hot-swap.
 */
interface ResolvedConfig {
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
}

export function createInferenceClient(config: InferenceClientConfig) {
  const state: ResolvedConfig = {
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature ?? 0.1,
    maxTokens: config.maxTokens ?? 4096,
    timeoutMs: config.timeoutMs ?? 60000
  }

  /** Non-streaming chat completion. Returns the full response. */
  async function complete(
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; toolChoice?: 'auto' | 'none' | 'required'; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const body: CompletionRequest = {
      model: state.model,
      messages,
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: false
    }
    if (opts?.tools?.length) {
      body.tools = opts.tools
      body.tool_choice = opts.toolChoice ?? 'auto'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), state.timeoutMs)

    // Forward external abort signal
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      const url = `${state.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Inference request failed: ${res.status} ${res.statusText} — ${text}`)
      }
      return (await res.json()) as CompletionResponse
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Streaming chat completion. Yields parsed SSE chunks as they arrive.
   * The caller can assemble the full message from deltas.
   */
  async function* stream(
    messages: ChatMessage[],
    opts?: { tools?: ToolSchema[]; toolChoice?: 'auto' | 'none' | 'required'; signal?: AbortSignal }
  ): AsyncGenerator<StreamChunk> {
    const body: CompletionRequest = {
      model: state.model,
      messages,
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: true
    }
    if (opts?.tools?.length) {
      body.tools = opts.tools
      body.tool_choice = opts.toolChoice ?? 'auto'
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), state.timeoutMs)

    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      const url = `${state.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Inference stream failed: ${res.status} ${res.statusText} — ${text}`)
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
            const chunk = JSON.parse(trimmed.slice(6)) as StreamChunk
            yield chunk
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Health check — GET /v1/models. */
  async function healthCheck(): Promise<boolean> {
    try {
      const url = `${state.baseUrl.replace(/\/+$/, '')}/v1/models`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** Update config at runtime (model hot-swap). Mutates the shared state
   *  object in place so `complete`/`stream`/`healthCheck` — already
   *  in flight or called after this returns — observe the new values. */
  function updateConfig(patch: Partial<InferenceClientConfig>): InferenceClientConfig {
    Object.assign(state, patch)
    return { ...state }
  }

  return { complete, stream, healthCheck, updateConfig, config: state }
}

export type InferenceClient = ReturnType<typeof createInferenceClient>
