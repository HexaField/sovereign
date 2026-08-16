// Public surface of the Claude Code adapter.

export { createClaudeCodeBackend, type ClaudeCodeBackend, type ClaudeCodeBackendDeps } from './claude-code.js'
export { claudeCodeConfigFromStore, claudeCodeConfigGetter } from './config.js'
export { createSovereignMcpServer, type SovereignToolDeps, type EmbeddingsToolDeps } from './mcp-server.js'
export { ensureLayeredContextFile, ensureDefaultSubagentFile, ensureAd4mSkill } from './personality.js'
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
export { createAskUserQuestionStore } from './ask-user-question-store.js'
export type { AskUserQuestionStore } from './ask-user-question-store.js'
