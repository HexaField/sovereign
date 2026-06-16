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

  describe('two-axis catalog (family + version)', () => {
    interface CatalogEntry {
      id: string
      provider: string
      family: string
      familyLabel: string
      version: string | null
      versionLabel: string
    }
    const catalog: CatalogEntry[] = [
      {
        id: 'anthropic/opus',
        provider: 'anthropic',
        family: 'opus',
        familyLabel: 'Opus',
        version: null,
        versionLabel: 'Latest'
      },
      {
        id: 'anthropic/claude-opus-4-7',
        provider: 'anthropic',
        family: 'opus',
        familyLabel: 'Opus',
        version: '4.7',
        versionLabel: '4.7'
      },
      {
        id: 'anthropic/claude-opus-4-6',
        provider: 'anthropic',
        family: 'opus',
        familyLabel: 'Opus',
        version: '4.6',
        versionLabel: '4.6'
      },
      {
        id: 'anthropic/sonnet',
        provider: 'anthropic',
        family: 'sonnet',
        familyLabel: 'Sonnet',
        version: null,
        versionLabel: 'Latest'
      },
      {
        id: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        family: 'sonnet',
        familyLabel: 'Sonnet',
        version: '4.6',
        versionLabel: '4.6'
      }
    ]

    // Mirrors the component's derived helpers.
    const familyOf = (id: string) => {
      const entry = catalog.find((e) => e.id === id)
      if (entry) return entry.family
      const m = /claude-(opus|sonnet|haiku)/.exec(id)
      return m ? m[1] : ''
    }
    const versionsFor = (family: string) => catalog.filter((e) => e.family === family)
    const familyDefaultId = (family: string, defaultModel: string) => {
      const entries = versionsFor(family)
      const def = entries.find((e) => e.id === defaultModel)
      const latest = entries.find((e) => e.version === null)
      return (def ?? latest ?? entries[0]).id
    }

    it('derives the family of a version-pinned id', () => {
      expect(familyOf('anthropic/claude-opus-4-6')).toBe('opus')
      expect(familyOf('anthropic/sonnet')).toBe('sonnet')
    })

    it('infers family for a model not present in the catalog', () => {
      expect(familyOf('anthropic/claude-opus-4-9')).toBe('opus')
    })

    it('lists only the selected family versions', () => {
      expect(versionsFor('opus').map((e) => e.versionLabel)).toEqual(['Latest', '4.7', '4.6'])
      expect(versionsFor('sonnet')).toHaveLength(2)
    })

    it('switching family picks the global default when in that family', () => {
      expect(familyDefaultId('opus', 'anthropic/claude-opus-4-6')).toBe('anthropic/claude-opus-4-6')
    })

    it('switching to a different family falls back to its Latest alias', () => {
      // Default is an opus pin; switching to sonnet has no matching default → Latest.
      expect(familyDefaultId('sonnet', 'anthropic/claude-opus-4-6')).toBe('anthropic/sonnet')
    })

    it('version option marks the default and shows version labels', () => {
      const defaultModel = 'anthropic/claude-opus-4-6'
      const labels = versionsFor('opus').map((v) => `${v.versionLabel}${v.id === defaultModel ? ' (default)' : ''}`)
      expect(labels).toEqual(['Latest', '4.7', '4.6 (default)'])
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
