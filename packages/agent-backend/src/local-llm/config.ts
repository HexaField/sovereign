// Resolve local-llm config from Sovereign's ConfigStore. Mirrors
// `SovereignConfig['agentBackend']['localLlm']` (see @sovereign/config's
// types.ts/defaults.ts) — every field here has a matching default there, so
// `configStore.get('agentBackend.localLlm')` never returns undefined in
// practice, but each field is still defaulted defensively.

import path from 'node:path'
import type { ConfigStore } from '@sovereign/config'

export interface LocalLlmConfig {
  /** Base URL for the OpenAI-compatible inference server (llama.cpp / ollama / vLLM). */
  baseUrl: string
  /** Model identifier sent in chat completion requests. */
  model: string
  /** Maximum context window in tokens — used for the usage bar, not enforced on the wire. */
  contextWindow: number
  /** Sampling temperature. */
  temperature: number
  /** Maximum output tokens per completion. */
  maxTokens: number
  /** Per-completion timeout in ms. At ~20 t/s decode, 32k tokens needs ~27 min.
   *  Default 600000 (10 min). The old 60s default starved slow models of output. */
  timeoutMs: number
  /** Enable model thinking (e.g. Qwen3 `<think>` blocks). When false, passes
   *  `chat_template_kwargs: { enable_thinking: false }` to the server and adds
   *  a system prompt instruction. Thinking tokens consume output budget. */
  thinking: boolean
  /** Tool-call format detection: auto | openai | hermes. Reserved for future prompt-format branching. */
  toolCallFormat: string
  /** Sandbox restrictions applied to every filesystem/shell tool call. */
  sandbox: {
    /** Directories tool calls may touch. Empty array = no restriction. */
    allowedCwds: string[]
    /** Maximum ms a Bash command may run before being killed. */
    bashTimeout: number
  }
}

interface RawLocalLlmConfig {
  baseUrl?: string
  model?: string
  contextWindow?: number
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  thinking?: boolean
  toolCallFormat?: string
  sandbox?: {
    allowedCwds?: string[]
    bashTimeout?: number
  }
}

export function localLlmConfigFromStore(configStore: ConfigStore, dataDir: string): LocalLlmConfig {
  // `dataDir` isn't consumed by this resolver today — the local-llm backend's
  // own state directory is derived by the caller (see local-llm.ts, which
  // takes `dataDir` directly) — but it's kept in the signature to match the
  // other backends' `xConfigFromStore(configStore, dataDir)` shape and because
  // future config (e.g. a per-install prompt cache path) will likely need it.
  void dataDir
  const cfg = configStore.get<RawLocalLlmConfig>('agentBackend.localLlm') ?? {}
  const home = process.env.HOME ?? ''
  return {
    baseUrl: cfg.baseUrl?.trim() || 'http://localhost:8080',
    model: cfg.model?.trim() || 'default',
    contextWindow: cfg.contextWindow ?? 32768,
    temperature: cfg.temperature ?? 0.1,
    maxTokens: cfg.maxTokens ?? 4096,
    timeoutMs: cfg.timeoutMs ?? 600_000,
    thinking: cfg.thinking !== false,
    toolCallFormat: cfg.toolCallFormat?.trim() || 'auto',
    sandbox: {
      allowedCwds: cfg.sandbox?.allowedCwds ?? (home ? [path.join(home, 'workspaces')] : []),
      bashTimeout: cfg.sandbox?.bashTimeout ?? 120000
    }
  }
}

/** Return a getter that re-reads local-llm config from the store on every
 *  call. Backends that accept `() => LocalLlmConfig` use this so config
 *  changes take effect without a restart. */
export function localLlmConfigGetter(configStore: ConfigStore, dataDir: string): () => LocalLlmConfig {
  return () => localLlmConfigFromStore(configStore, dataDir)
}
