// Endpoint resolver — maps model ids to the inference endpoint that serves them.
//
// When multiple endpoints appear in the config, the resolver finds the one
// whose `models` array includes the requested model. When no match exists it
// falls back to the first endpoint's default model. When no endpoints are
// configured it synthesises a single-endpoint view from the flat localLlm
// fields for full backward compatibility.
//
// Every caller receives a `ResolvedEndpoint` that already holds a fully-merged
// `InferenceClientConfig` (global defaults + per-endpoint overrides) — callers
// pass it directly to `createAiSdkInferenceClient` without any further merging.

import type { InferenceClientConfig, ReasoningConfig } from './inference.js'
import type { LocalLlmConfig, EndpointConfig } from './config.js'

// ── Public types ──────────────────────────────────────────────────────────

export interface ResolvedEndpoint {
  /** Endpoint identifier from the config (or "default" for the synthesised entry). */
  id: string
  /** Human-readable label. */
  label: string
  /** Base URL of the inference server. */
  baseUrl: string
  /** Model id to send in requests. */
  model: string
  /** Fully merged InferenceClientConfig ready to pass to createAiSdkInferenceClient. */
  config: InferenceClientConfig
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Build a merged InferenceClientConfig from global defaults + per-endpoint overrides
 *  + the specific model and baseUrl that were resolved for this request. */
function mergeConfig(
  model: string,
  baseUrl: string,
  global: LocalLlmConfig,
  overrides: EndpointConfig['overrides']
): InferenceClientConfig {
  const o = overrides ?? {}
  const baseReasoning: ReasoningConfig = global.reasoning

  const reasoning: ReasoningConfig = o.reasoning
    ? {
        enabled: o.reasoning.enabled ?? baseReasoning.enabled,
        effort: o.reasoning.effort ?? baseReasoning.effort,
        maxTokens: o.reasoning.maxTokens ?? baseReasoning.maxTokens
      }
    : baseReasoning

  return {
    baseUrl,
    model,
    contextWindow: o.contextWindow ?? global.contextWindow,
    temperature: o.temperature ?? global.temperature,
    maxTokens: o.maxTokens ?? global.maxTokens,
    timeoutMs: o.timeoutMs ?? global.timeoutMs,
    reasoning
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Resolve which endpoint serves `model`.
 *
 * Resolution order:
 * 1. Exact match — find the endpoint whose `models` array contains `model`.
 * 2. Fallback — no match; use the first endpoint with its `defaultModel`.
 * 3. Synthesised — no endpoints configured; use flat localLlm fields directly.
 */
export function resolveEndpoint(model: string, cfg: LocalLlmConfig): ResolvedEndpoint {
  if (cfg.endpoints.length === 0) {
    // Backward-compat path: no endpoints — flat fields only.
    return {
      id: 'default',
      label: 'Default',
      baseUrl: cfg.baseUrl,
      model,
      config: mergeConfig(model, cfg.baseUrl, cfg, undefined)
    }
  }

  // Exact model match — O(n·m) but n endpoints and m models are tiny.
  for (const ep of cfg.endpoints) {
    if (ep.models.includes(model)) {
      return {
        id: ep.id,
        label: ep.label ?? ep.id,
        baseUrl: ep.baseUrl,
        model,
        config: mergeConfig(model, ep.baseUrl, cfg, ep.overrides)
      }
    }
  }

  // No endpoint claims this model — route to the first endpoint's default.
  return resolveDefaultEndpoint(cfg)
}

/**
 * Resolve the default endpoint (first configured endpoint, or flat fields).
 * Used for new sessions that have no model preference and for the probe
 * client created at backend startup.
 */
export function resolveDefaultEndpoint(cfg: LocalLlmConfig): ResolvedEndpoint {
  if (cfg.endpoints.length === 0) {
    return {
      id: 'default',
      label: 'Default',
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      config: mergeConfig(cfg.model, cfg.baseUrl, cfg, undefined)
    }
  }

  const ep = cfg.endpoints[0]
  const model = ep.defaultModel ?? ep.models[0] ?? cfg.model
  return {
    id: ep.id,
    label: ep.label ?? ep.id,
    baseUrl: ep.baseUrl,
    model,
    config: mergeConfig(model, ep.baseUrl, cfg, ep.overrides)
  }
}
