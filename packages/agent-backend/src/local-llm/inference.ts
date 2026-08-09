// OpenAI-compatible inference client for the local-llm backend.
// Self-contained — does not import from @sovereign/summary to avoid
// cross-package coupling.

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
    const body: Record<string, unknown> = {
      model: state.model,
      messages,
      temperature: state.temperature,
      max_tokens: state.maxTokens,
      stream: false
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Inference failed: ${res.status} ${res.statusText} — ${text}`)
      }
      return (await res.json()) as CompletionResponse
    } finally {
      clearTimeout(timer)
    }
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
      stream: true
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
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
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
