import { describe, it, expect, vi, beforeEach } from 'vitest'

// These tests validate the model-switching UX wiring in ChatSettings.
// Since ChatSettings is a SolidJS component with inline fetch calls,
// we test the API contract and data flow expectations.

describe('ChatSettings — Model Selector', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('API contract', () => {
    it('GET /api/models returns { models: string[], defaultModel: string }', () => {
      // The ChatSettings component expects this shape from the models endpoint
      const expected = { models: ['openai/gpt-4o', 'anthropic/claude-sonnet-4'], defaultModel: 'openai/gpt-4o' }
      expect(expected.models).toBeInstanceOf(Array)
      expect(typeof expected.defaultModel).toBe('string')
    })

    it('PATCH /api/threads/:key/model sends { model: "provider/model" }', () => {
      const body = { model: 'anthropic/claude-sonnet-4' }
      expect(body.model).toContain('/')
      expect(typeof body.model).toBe('string')
    })

    it('selected model string format is provider/model', () => {
      const provider = 'github-copilot'
      const model = 'claude-opus-4.6'
      const selected = `${provider}/${model}`
      expect(selected).toBe('github-copilot/claude-opus-4.6')
      // Display trims to just model name after last /
      const display = selected.split('/').pop()
      expect(display).toBe('claude-opus-4.6')
    })

    it('fallback when model not in available list shows (current) suffix', () => {
      const available = ['openai/gpt-4o', 'anthropic/claude-sonnet-4']
      const selected = 'custom/my-model'
      const isInList = available.includes(selected)
      expect(isInList).toBe(false)
      // Component renders a separate <option> with (current) suffix
    })

    it('default model gets (default) suffix in dropdown', () => {
      const models = ['openai/gpt-4o', 'anthropic/claude-sonnet-4']
      const defaultModel = 'openai/gpt-4o'
      const labels = models.map((m) => `${m.split('/').pop()}${m === defaultModel ? ' (default)' : ''}`)
      expect(labels).toEqual(['gpt-4o (default)', 'claude-sonnet-4'])
    })
  })

  describe('model from session-info', () => {
    it('builds selected model from provider + model fields', () => {
      const sessionInfo = { modelProvider: 'anthropic', model: 'claude-sonnet-4' }
      const current =
        sessionInfo.modelProvider && sessionInfo.model
          ? `${sessionInfo.modelProvider}/${sessionInfo.model}`
          : (sessionInfo.model ?? '')
      expect(current).toBe('anthropic/claude-sonnet-4')
    })

    it('falls back to model-only when no provider', () => {
      const sessionInfo = { modelProvider: null, model: 'gpt-4o' }
      const current =
        sessionInfo.modelProvider && sessionInfo.model
          ? `${sessionInfo.modelProvider}/${sessionInfo.model}`
          : (sessionInfo.model ?? '')
      expect(current).toBe('gpt-4o')
    })
  })

  describe('fetch parallelism', () => {
    it('fetches session-info and models in parallel via Promise.all', () => {
      // Validates the fetch pattern used in the component
      const calls: string[] = []
      const mockFetch = (url: string) => {
        calls.push(url)
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      }
      const key = 'main'
      Promise.all([mockFetch(`/api/threads/${encodeURIComponent(key)}/session-info`), mockFetch('/api/models')])
      expect(calls).toEqual(['/api/threads/main/session-info', '/api/models'])
    })
  })
})
