// Public surface of the agent-backend layer. Nothing outside this directory
// should import from `./openclaw/*`, `./pi/*`, `./claude-code/*`, or
// `./shared/*` directly — those are implementation details.

export { createBackend } from './factory.js'
export type { RoutingBackend, MultiBackendConfig, BackendInstance } from './factory.js'
export { routingAsBackend } from './routing-as-backend.js'
export { createSessionsRegistry } from './shared/sessions-registry.js'
export type { SessionsRegistry, ThreadSessionRecord } from './shared/sessions-registry.js'

// Re-export the canonical interface types from core so consumers only need a
// single import.
export type {
  AgentBackend,
  AgentBackendKind,
  AgentBackendEvents,
  BackendCapabilities,
  BackendConnectionStatus,
  CreateSessionOptions,
  ContextBudget,
  DeviceInfo,
  SessionKind,
  SessionMeta,
  SessionSummary,
  SpawnSubagentOptions,
  SubagentSummary
} from '@sovereign/core'

// OpenClaw adapter — exposed so the server wire-up can construct one.
export { createOpenClawBackend } from './openclaw/openclaw.js'
export type { OpenClawBackend } from './openclaw/openclaw.js'
export type { OpenClawConfig } from './openclaw/types.js'
