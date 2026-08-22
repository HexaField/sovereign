// Resolve local-llm config from Sovereign's ConfigStore. Mirrors
// `SovereignConfig['agentBackend']['localLlm']` (see @sovereign/config's
// types.ts/defaults.ts) — every field here has a matching default there, so
// `configStore.get('agentBackend.localLlm')` never returns undefined in
// practice, but each field is still defaulted defensively.

import path from 'node:path'
import type { ConfigStore } from '@sovereign/config'
import type { ReasoningConfig } from './inference.js'

export type { ReasoningConfig }

// ── Per-endpoint override block ───────────────────────────────────────────

/** Per-endpoint overrides merged on top of the flat localLlm defaults. */
export interface EndpointOverrides {
  temperature?: number
  maxTokens?: number
  contextWindow?: number
  compactThreshold?: number
  timeoutMs?: number
  reasoning?: { enabled?: boolean; effort?: string; maxTokens?: number }
}

/** A single named inference endpoint. */
export interface EndpointConfig {
  /** Unique identifier used for routing and logging (e.g. "rocmfpx", "cpu"). */
  id: string
  /** Human-readable label shown in the UI model picker. */
  label?: string
  /** Base URL for this endpoint's OpenAI-compatible API. */
  baseUrl: string
  /** Model ids served by this endpoint. Matched against the session model. */
  models: string[]
  /** Default model for new sessions routed here. Falls back to models[0]. */
  defaultModel?: string
  /** Per-endpoint overrides applied on top of the flat localLlm defaults. */
  overrides?: EndpointOverrides
}

// ── Main config type ──────────────────────────────────────────────────────

export interface LocalLlmConfig {
  /** Base URL for the OpenAI-compatible inference server (llama.cpp / ollama / vLLM). */
  baseUrl: string
  /** Model identifier sent in chat completion requests. */
  model: string
  /** Maximum context window in tokens — used for the usage bar, not enforced on the wire. */
  contextWindow: number
  /** Compact when prompt tokens exceed this value. When unset, falls back to
   *  contextWindow × 0.75. Set this to control the compaction trigger point
   *  independently of the context window (e.g. compact at 100K in a 131K window). */
  compactThreshold?: number
  /** Sampling temperature. */
  temperature: number
  /** Maximum output tokens per completion. */
  maxTokens: number
  /** Per-completion timeout in ms. At ~20 t/s decode, 32k tokens needs ~27 min.
   *  Default 600000 (10 min). The old 60s default starved slow models of output. */
  timeoutMs: number
  /** Reasoning/thinking mode configuration. Controls chain-of-thought via
   *  chat_template_kwargs on llama.cpp servers. Derived from the raw config's
   *  `reasoning` block; falls back to the deprecated `thinking` boolean. */
  reasoning: ReasoningConfig
  /** Tool-call format detection: auto | openai | hermes. Reserved for future prompt-format branching. */
  toolCallFormat: string
  /** Path to a JSON model registry (e.g. `~/.local/share/llama.cpp/models.json`).
   *  When set, `listAvailableModels` reads all entries from the registry instead
   *  of relying solely on the running server's `/v1/models` (which reports only
   *  the single loaded model). */
  modelsRegistry: string | null
  /** Sandbox restrictions applied to every filesystem/shell tool call. */
  sandbox: {
    /** Directories tool calls may touch. Empty array = no restriction. */
    allowedCwds: string[]
    /** Maximum ms a Bash command may run before being killed. */
    bashTimeout: number
  }
  /**
   * Named inference endpoints. When empty, a single endpoint is synthesised
   * from the flat baseUrl/model fields for backward compatibility.
   * When populated, the backend routes each model request to the endpoint whose
   * `models` array contains it.
   */
  endpoints: EndpointConfig[]
}

// ── Raw (un-normalised) config from the store ─────────────────────────────

interface RawLocalLlmConfig {
  baseUrl?: string
  model?: string
  contextWindow?: number
  compactThreshold?: number
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  /** @deprecated Use `reasoning` instead. Auto-synthesised into a ReasoningConfig. */
  thinking?: boolean
  /** Reasoning/thinking mode configuration. Takes precedence over `thinking`. */
  reasoning?: {
    enabled?: boolean
    effort?: string
    maxTokens?: number
  }
  toolCallFormat?: string
  modelsRegistry?: string
  sandbox?: {
    allowedCwds?: string[]
    bashTimeout?: number
  }
  endpoints?: Array<{
    id?: string
    label?: string
    baseUrl?: string
    models?: string[]
    defaultModel?: string
    overrides?: {
      temperature?: number
      maxTokens?: number
      contextWindow?: number
      compactThreshold?: number
      timeoutMs?: number
      reasoning?: { enabled?: boolean; effort?: string; maxTokens?: number }
    }
  }>
}

// ── Helpers ───────────────────────────────────────────────────────────────

const DEFAULT_REASONING: ReasoningConfig = {
  enabled: false,
  effort: 'medium',
  maxTokens: 2048
}

/** Normalise raw config into a ReasoningConfig. Handles three cases:
 *  1. `reasoning` block present — use it (with defaults for missing fields).
 *  2. Only `thinking: boolean` present — synthesise from it (deprecated path).
 *  3. Neither — use DEFAULT_REASONING. */
function resolveReasoning(cfg: RawLocalLlmConfig): ReasoningConfig {
  if (cfg.reasoning) {
    return {
      enabled: cfg.reasoning.enabled ?? DEFAULT_REASONING.enabled,
      effort: cfg.reasoning.effort?.trim() || DEFAULT_REASONING.effort,
      maxTokens: cfg.reasoning.maxTokens ?? DEFAULT_REASONING.maxTokens
    }
  }
  if (typeof cfg.thinking === 'boolean') {
    // Legacy path: thinking:true → reasoning enabled with defaults
    return { ...DEFAULT_REASONING, enabled: cfg.thinking }
  }
  return DEFAULT_REASONING
}

/** Normalise the raw `endpoints` array into typed EndpointConfig[].
 *  Filters out entries with no baseUrl and assigns auto-generated ids when
 *  the id field is missing. */
function resolveEndpoints(raw: RawLocalLlmConfig['endpoints']): EndpointConfig[] {
  if (!raw || raw.length === 0) return []
  return raw
    .filter((ep) => ep.baseUrl?.trim())
    .map((ep, i) => ({
      id: ep.id?.trim() || `endpoint-${i}`,
      label: ep.label,
      baseUrl: ep.baseUrl!.trim(),
      models: Array.isArray(ep.models) ? ep.models.filter((m) => typeof m === 'string' && m.trim()) : [],
      defaultModel: ep.defaultModel?.trim() || undefined,
      overrides: ep.overrides
    }))
}

// ── Public API ────────────────────────────────────────────────────────────

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
    compactThreshold: cfg.compactThreshold,
    temperature: cfg.temperature ?? 0.1,
    maxTokens: cfg.maxTokens ?? 4096,
    timeoutMs: cfg.timeoutMs ?? 600_000,
    reasoning: resolveReasoning(cfg),
    toolCallFormat: cfg.toolCallFormat?.trim() || 'auto',
    modelsRegistry:
      cfg.modelsRegistry?.trim() || (home ? path.join(home, '.local', 'share', 'llama.cpp', 'models.json') : null),
    sandbox: {
      allowedCwds: cfg.sandbox?.allowedCwds ?? (home ? [path.join(home, 'workspaces')] : []),
      bashTimeout: cfg.sandbox?.bashTimeout ?? 120000
    },
    endpoints: resolveEndpoints(cfg.endpoints)
  }
}

/** Return a getter that re-reads local-llm config from the store on every
 *  call. Backends that accept `() => LocalLlmConfig` use this so config
 *  changes take effect without a restart. */
export function localLlmConfigGetter(configStore: ConfigStore, dataDir: string): () => LocalLlmConfig {
  return () => localLlmConfigFromStore(configStore, dataDir)
}
