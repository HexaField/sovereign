// Public surface of the local-llm adapter.

export { createLocalLlmBackend, type LocalLlmBackend } from './local-llm.js'
export { localLlmConfigFromStore, localLlmConfigGetter, type LocalLlmConfig } from './config.js'
export { type InferenceClient, type InferenceClientConfig, type ReasoningConfig } from './inference.js'
// createInferenceClient is the public alias for the AI SDK-backed implementation.
export { createAiSdkInferenceClient as createInferenceClient } from './ai-sdk-inference.js'
