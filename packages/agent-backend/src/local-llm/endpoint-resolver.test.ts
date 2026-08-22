import { describe, it, expect } from 'vitest'
import { resolveEndpoint, resolveDefaultEndpoint } from './endpoint-resolver.js'
import type { LocalLlmConfig, EndpointConfig } from './config.js'

// ── Fixtures ──────────────────────────────────────────────────────────────

const BASE_REASONING = { enabled: false, effort: 'medium', maxTokens: 2048 }

function makeGlobal(overrides?: Partial<LocalLlmConfig>): LocalLlmConfig {
  return {
    baseUrl: 'http://localhost:8080',
    model: 'default-model',
    contextWindow: 32768,
    temperature: 0.1,
    maxTokens: 4096,
    timeoutMs: 600_000,
    reasoning: BASE_REASONING,
    toolCallFormat: 'auto',
    modelsRegistry: null,
    sandbox: { allowedCwds: [], bashTimeout: 120000 },
    endpoints: [],
    ...overrides
  }
}

const ROCMFPX_EP: EndpointConfig = {
  id: 'rocmfpx',
  label: 'ROCmFPX Vulkan',
  baseUrl: 'http://127.0.0.1:9090',
  models: ['qwen3-fast', 'qwen3-fast-v2'],
  defaultModel: 'qwen3-fast'
}

const CPU_EP: EndpointConfig = {
  id: 'cpu',
  label: 'CPU fallback',
  baseUrl: 'http://127.0.0.1:8080',
  models: ['qwen3-small'],
  defaultModel: 'qwen3-small'
}

// ── No endpoints (backward-compat) ────────────────────────────────────────

describe('resolveEndpoint — no endpoints configured', () => {
  it('uses flat baseUrl and model from global config', () => {
    const cfg = makeGlobal()
    const result = resolveEndpoint('my-model', cfg)
    expect(result.id).toBe('default')
    expect(result.baseUrl).toBe('http://localhost:8080')
    expect(result.model).toBe('my-model')
    expect(result.config.baseUrl).toBe('http://localhost:8080')
    expect(result.config.model).toBe('my-model')
  })

  it('inherits global temperature and maxTokens', () => {
    const cfg = makeGlobal({ temperature: 0.7, maxTokens: 2048 })
    const result = resolveEndpoint('any-model', cfg)
    expect(result.config.temperature).toBe(0.7)
    expect(result.config.maxTokens).toBe(2048)
  })

  it('inherits global reasoning config', () => {
    const cfg = makeGlobal({ reasoning: { enabled: true, effort: 'high', maxTokens: 1024 } })
    const result = resolveEndpoint('any-model', cfg)
    expect(result.config.reasoning).toEqual({ enabled: true, effort: 'high', maxTokens: 1024 })
  })
})

describe('resolveDefaultEndpoint — no endpoints configured', () => {
  it('returns synthesised default from flat fields', () => {
    const cfg = makeGlobal()
    const result = resolveDefaultEndpoint(cfg)
    expect(result.id).toBe('default')
    expect(result.model).toBe('default-model')
    expect(result.baseUrl).toBe('http://localhost:8080')
  })
})

// ── Exact model match ─────────────────────────────────────────────────────

describe('resolveEndpoint — with endpoints, exact match', () => {
  it('routes qwen3-fast to rocmfpx endpoint', () => {
    const cfg = makeGlobal({ endpoints: [ROCMFPX_EP, CPU_EP] })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.id).toBe('rocmfpx')
    expect(result.label).toBe('ROCmFPX Vulkan')
    expect(result.baseUrl).toBe('http://127.0.0.1:9090')
    expect(result.model).toBe('qwen3-fast')
    expect(result.config.baseUrl).toBe('http://127.0.0.1:9090')
  })

  it('routes qwen3-fast-v2 to rocmfpx endpoint', () => {
    const cfg = makeGlobal({ endpoints: [ROCMFPX_EP, CPU_EP] })
    const result = resolveEndpoint('qwen3-fast-v2', cfg)
    expect(result.id).toBe('rocmfpx')
    expect(result.model).toBe('qwen3-fast-v2')
  })

  it('routes qwen3-small to cpu endpoint', () => {
    const cfg = makeGlobal({ endpoints: [ROCMFPX_EP, CPU_EP] })
    const result = resolveEndpoint('qwen3-small', cfg)
    expect(result.id).toBe('cpu')
    expect(result.baseUrl).toBe('http://127.0.0.1:8080')
    expect(result.model).toBe('qwen3-small')
  })
})

// ── Fallback when no endpoint claims the model ────────────────────────────

describe('resolveEndpoint — no endpoint claims the model', () => {
  it('falls back to the first endpoint and its default model', () => {
    const cfg = makeGlobal({ endpoints: [ROCMFPX_EP, CPU_EP] })
    const result = resolveEndpoint('unknown-model', cfg)
    expect(result.id).toBe('rocmfpx')
    expect(result.model).toBe('qwen3-fast') // ROCMFPX_EP.defaultModel
    expect(result.baseUrl).toBe('http://127.0.0.1:9090')
  })

  it('falls back to first endpoint models[0] when defaultModel is absent', () => {
    const epNoDefault: EndpointConfig = { ...ROCMFPX_EP, defaultModel: undefined }
    const cfg = makeGlobal({ endpoints: [epNoDefault] })
    const result = resolveEndpoint('unknown-model', cfg)
    expect(result.model).toBe('qwen3-fast') // models[0]
  })

  it('falls back to global model when endpoint has no models and no defaultModel', () => {
    const epEmpty: EndpointConfig = { id: 'empty', baseUrl: 'http://localhost:7777', models: [] }
    const cfg = makeGlobal({ endpoints: [epEmpty], model: 'global-fallback' })
    const result = resolveEndpoint('unknown-model', cfg)
    expect(result.model).toBe('global-fallback')
  })
})

// ── Per-endpoint overrides ────────────────────────────────────────────────

describe('resolveEndpoint — per-endpoint overrides', () => {
  it('endpoint temperature overrides global temperature', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP, overrides: { temperature: 0.9 } }
    const cfg = makeGlobal({ endpoints: [ep], temperature: 0.1 })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.config.temperature).toBe(0.9)
  })

  it('endpoint maxTokens overrides global maxTokens', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP, overrides: { maxTokens: 8192 } }
    const cfg = makeGlobal({ endpoints: [ep], maxTokens: 4096 })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.config.maxTokens).toBe(8192)
  })

  it('endpoint timeoutMs overrides global timeoutMs', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP, overrides: { timeoutMs: 300_000 } }
    const cfg = makeGlobal({ endpoints: [ep], timeoutMs: 600_000 })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.config.timeoutMs).toBe(300_000)
  })

  it('endpoint reasoning overrides merge field-by-field with global defaults', () => {
    const ep: EndpointConfig = {
      ...ROCMFPX_EP,
      overrides: { reasoning: { enabled: true, effort: 'high' } }
    }
    const cfg = makeGlobal({ endpoints: [ep], reasoning: { enabled: false, effort: 'medium', maxTokens: 2048 } })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.config.reasoning.enabled).toBe(true)
    expect(result.config.reasoning.effort).toBe('high')
    // maxTokens not overridden — falls back to global default
    expect(result.config.reasoning.maxTokens).toBe(2048)
  })

  it('absent overrides pass global values through unchanged', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP, overrides: undefined }
    const cfg = makeGlobal({ endpoints: [ep] })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.config.temperature).toBe(0.1)
    expect(result.config.maxTokens).toBe(4096)
    expect(result.config.reasoning).toEqual(BASE_REASONING)
  })
})

// ── resolveDefaultEndpoint ────────────────────────────────────────────────

describe('resolveDefaultEndpoint — with endpoints', () => {
  it('returns first endpoint with its defaultModel', () => {
    const cfg = makeGlobal({ endpoints: [ROCMFPX_EP, CPU_EP] })
    const result = resolveDefaultEndpoint(cfg)
    expect(result.id).toBe('rocmfpx')
    expect(result.model).toBe('qwen3-fast')
    expect(result.baseUrl).toBe('http://127.0.0.1:9090')
  })

  it('uses models[0] when defaultModel is absent on the first endpoint', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP, defaultModel: undefined }
    const cfg = makeGlobal({ endpoints: [ep] })
    const result = resolveDefaultEndpoint(cfg)
    expect(result.model).toBe('qwen3-fast')
  })

  it('applies overrides on the default endpoint', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP, overrides: { maxTokens: 16384 } }
    const cfg = makeGlobal({ endpoints: [ep] })
    const result = resolveDefaultEndpoint(cfg)
    expect(result.config.maxTokens).toBe(16384)
  })
})

// ── Label fallback ────────────────────────────────────────────────────────

describe('resolveEndpoint — label handling', () => {
  it('uses id as label when label is absent', () => {
    const ep: EndpointConfig = { id: 'my-ep', baseUrl: 'http://a:1', models: ['m'], defaultModel: 'm' }
    const cfg = makeGlobal({ endpoints: [ep] })
    const result = resolveEndpoint('m', cfg)
    expect(result.label).toBe('my-ep')
  })

  it('uses provided label when present', () => {
    const ep: EndpointConfig = { ...ROCMFPX_EP }
    const cfg = makeGlobal({ endpoints: [ep] })
    const result = resolveEndpoint('qwen3-fast', cfg)
    expect(result.label).toBe('ROCmFPX Vulkan')
  })
})
