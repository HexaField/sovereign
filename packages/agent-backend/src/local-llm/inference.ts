// OpenAI-compatible inference types for the local-llm backend.
// Self-contained — does not import from @sovereign/summary to avoid
// cross-package coupling.
//
// NOTE: The createInferenceClient raw-SSE implementation was removed in
// Phase 2 cleanup. The AI SDK client (ai-sdk-inference.ts) is the sole
// production client. This file now holds shared types + ContextOverflowError.

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
  /** Full reasoning/thinking content produced by this completion, if any.
   *  Populated when the model emits reasoning-delta events (thinking mode enabled)
   *  or embeds <think>...</think> blocks in the content stream. */
  reasoning?: string
}

/** Reasoning/thinking configuration for a single inference client instance.
 *  Controls chain-of-thought output via chat_template_kwargs on llama.cpp servers
 *  (and the equivalent field on other OpenAI-compatible endpoints). */
export interface ReasoningConfig {
  /** When true, sends enable_thinking: true to the server. */
  enabled: boolean
  /** Effort level passed as reasoning_effort to the server.
   *  Qwen3 supports 'low' | 'medium' | 'high'. Only sent when enabled is true. */
  effort: string
  /** Hard cap on reasoning tokens per completion, sent as max_reasoning_tokens.
   *  Prevents the model from consuming the entire output budget on thinking.
   *  Set to 0 to send no cap. */
  maxTokens: number
}

export interface InferenceClientConfig {
  baseUrl: string
  model: string
  contextWindow?: number
  temperature: number
  maxTokens: number
  timeoutMs?: number
  /** Reasoning/thinking mode configuration.
   *  Controls chain-of-thought via chat_template_kwargs on llama.cpp servers. */
  reasoning: ReasoningConfig
}

/** The inference client contract — every implementation must provide these. */
export interface InferenceClient {
  complete(messages: ChatMessage[], opts?: { tools?: ToolSchema[]; signal?: AbortSignal }): Promise<CompletionResponse>
  healthCheck(): Promise<boolean>
  updateConfig(patch: Partial<InferenceClientConfig>): void
}

/** @deprecated Streaming chunk type — retained for code that references StreamChunk
 *  in comments or historical context. No longer emitted by the production client. */
export interface StreamChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      /** Models with thinking mode (Qwen3.x etc.) may stream reasoning here
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
