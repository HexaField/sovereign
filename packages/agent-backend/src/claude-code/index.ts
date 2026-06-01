// Public surface of the Claude Code adapter.

export { createClaudeCodeBackend, type ClaudeCodeBackend, type ClaudeCodeBackendDeps } from './claude-code.js'
export { claudeCodeConfigFromStore } from './config.js'
export { createSovereignMcpServer, type SovereignToolDeps } from './mcp-server.js'
export { ensureLayeredContextFile, ensureDefaultSubagentFile } from './personality.js'
export { createPersonalityCompiler } from './personality-compiler.js'
export type { PersonalityCompiler, PersonalityCompilerOptions, PersonalityManifest } from './personality-compiler.js'
export {
  parseClaudeCodeTurns,
  readAllClaudeCodeMessages,
  readRecentClaudeCodeMessages,
  normalizeClaudeCodeEntry,
  computeUsageFromFile
} from './history.js'
export { encodeCwdToProjectDir, defaultAgentDir, sessionJsonlPath, projectsDirForCwd } from './path-encoding.js'
export type { ClaudeCodeConfig, ClaudeSessionState } from './types.js'
