// Public surface of the Claude Code adapter.

export { createClaudeCodeBackend, type ClaudeCodeBackend, type ClaudeCodeBackendDeps } from './claude-code.js'
export { claudeCodeConfigFromStore } from './config.js'
export { createWorkspaceIndex, type WorkspaceIndex, type WorkspaceEntry } from './workspace-index.js'
export { createSovereignMcpServer, type SovereignToolDeps } from './mcp-server.js'
export { ensurePersonalityFile, ensureLayeredContextFile, ensureDefaultSubagentFile } from './personality.js'
export {
  parseClaudeCodeTurns,
  readAllClaudeCodeMessages,
  readRecentClaudeCodeMessages,
  normalizeClaudeCodeEntry,
  computeUsageFromFile
} from './history.js'
export { encodeCwdToProjectDir, defaultAgentDir, sessionJsonlPath, projectsDirForCwd } from './path-encoding.js'
export type { ClaudeCodeConfig, ClaudeSessionState } from './types.js'
