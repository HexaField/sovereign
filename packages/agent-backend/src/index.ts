// Public surface of the agent-backend layer. Nothing outside this package
// should import from `./pi/*` or `./claude-code/*` directly — those are
// implementation details.

export { createBackend } from './factory.js'
export type { RoutingBackend, MultiBackendConfig, BackendInstance } from './factory.js'
export { routingAsBackend } from './routing-as-backend.js'
export { wireAgentBackend } from './wiring.js'
export type { AgentBackendWiringInput, AgentBackendWiringResult } from './wiring.js'
export { buildSovereignMcpDeps } from './mcp-deps.js'
export type { SovereignMcpDepsInput } from './mcp-deps.js'
export { createSessionsRegistry } from '@sovereign/primitives'
export type { SessionsRegistry, ThreadSessionRecord } from '@sovereign/primitives'
export { createActiveSessions } from './active-sessions.js'
export type {
  ActiveSessions,
  ActiveSessionEntry,
  ActiveAgentStatus,
  ActiveSubagent,
  CreateActiveSessionsOptions
} from './active-sessions.js'
export { resumeActiveSessions } from './resume.js'
export type { ResumeOrchestratorOptions, ResumeOutcome, ResumeReport } from './resume.js'

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

// Claude Code adapter
export {
  createClaudeCodeBackend,
  claudeCodeConfigFromStore,
  createSovereignMcpServer,
  createPersonalityCompiler,
  type ClaudeCodeBackend,
  type SovereignToolDeps,
  type PersonalityCompiler,
  type PersonalityCompilerOptions,
  type PersonalityManifest
} from './claude-code/index.js'
