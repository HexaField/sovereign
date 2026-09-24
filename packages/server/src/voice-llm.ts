import type { ConfigStore, SovereignConfig } from '@sovereign/config'
import { createInferenceClient, localLlmConfigFromStore } from '@sovereign/agent-backend'

type ClientFactory = typeof createInferenceClient
type InferenceClient = ReturnType<ClientFactory>

const NO_REASONING = { enabled: false, effort: 'medium', maxTokens: 0 } as const

/**
 * The voice pipeline's two LLM clients: `voiceLlm` for acknowledgements and
 * spoken summaries, `summaryLlm` for the gateway thread's rolling
 * conversation summary. Both call `voice.llmBaseUrl` / `voice.llmModel` when
 * set, else the local-LLM backend, and follow changes to either section.
 *
 * Two instances, not one: the conversation summary needs a larger token
 * budget, and a shared client would race the two prompts' generations.
 */
export function createVoiceLlmClients(
  configStore: ConfigStore,
  dataDir: string,
  createClient: ClientFactory = createInferenceClient
): { voiceLlm: InferenceClient; summaryLlm: InferenceClient } {
  const endpoint = () => {
    const llm = localLlmConfigFromStore(configStore, dataDir)
    const voice = configStore.get<SovereignConfig['voice']>('voice')
    return {
      baseUrl: voice?.llmBaseUrl?.trim() || llm.baseUrl,
      model: voice?.llmModel?.trim() || llm.model
    }
  }
  const voiceLlm = createClient({
    ...endpoint(),
    temperature: 0.3,
    maxTokens: 150,
    timeoutMs: 15_000,
    reasoning: { ...NO_REASONING }
  })
  const summaryLlm = createClient({
    ...endpoint(),
    temperature: 0.3,
    maxTokens: 200,
    timeoutMs: 20_000,
    reasoning: { ...NO_REASONING }
  })
  const reload = () => {
    const next = endpoint()
    voiceLlm.updateConfig(next)
    summaryLlm.updateConfig(next)
  }
  configStore.onChange('agentBackend.localLlm', reload)
  configStore.onChange('voice', reload)
  return { voiceLlm, summaryLlm }
}
