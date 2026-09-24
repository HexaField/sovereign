import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createConfigStore } from '@sovereign/config'
import { createVoiceLlmClients } from './voice-llm.js'

type FakeConfig = { baseUrl: string; model: string; maxTokens?: number }

/** Records each client's config, applying updateConfig the way the real client does. */
function fakeClientFactory() {
  return ((initial: FakeConfig) => {
    const config = { ...initial }
    return { config, updateConfig: (patch: Partial<FakeConfig>) => Object.assign(config, patch) }
  }) as unknown as Parameters<typeof createVoiceLlmClients>[2]
}

function setup(voice?: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'sov-voice-llm-'))
  const configStore = createConfigStore(createEventBus(dir), dir, dir)
  configStore.patch({ agentBackend: { localLlm: { baseUrl: 'http://local:9090', model: 'local-model' } } })
  if (voice) configStore.patch({ voice })
  const clients = createVoiceLlmClients(configStore, dir, fakeClientFactory()) as unknown as {
    voiceLlm: { config: FakeConfig }
    summaryLlm: { config: FakeConfig }
  }
  return { configStore, ...clients }
}

describe('createVoiceLlmClients', () => {
  it('points both clients at the voice LLM override — the conversation summary too', () => {
    const { voiceLlm, summaryLlm } = setup({ llmBaseUrl: 'http://voice:9091', llmModel: 'voice-model' })
    for (const client of [voiceLlm, summaryLlm]) {
      expect(client.config).toMatchObject({ baseUrl: 'http://voice:9091', model: 'voice-model' })
    }
  })

  it('falls back to the local-LLM backend, and both clients follow later changes to either section', () => {
    const { configStore, voiceLlm, summaryLlm } = setup()
    const baseUrls = () => [voiceLlm, summaryLlm].map((c) => c.config.baseUrl)
    expect(baseUrls()).toEqual(['http://local:9090', 'http://local:9090'])

    configStore.patch({ voice: { llmBaseUrl: 'http://voice:9091' } })
    expect(baseUrls()).toEqual(['http://voice:9091', 'http://voice:9091'])

    configStore.patch({ voice: { llmBaseUrl: '  ' }, agentBackend: { localLlm: { baseUrl: 'http://local:9095' } } })
    expect(baseUrls()).toEqual(['http://local:9095', 'http://local:9095'])
  })

  it('keeps the budgets apart: the summary client gets the larger one', () => {
    const { voiceLlm, summaryLlm } = setup()
    expect(voiceLlm.config.maxTokens).toBe(150)
    expect(summaryLlm.config.maxTokens).toBe(200)
  })
})
