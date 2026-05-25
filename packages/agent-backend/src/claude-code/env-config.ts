// Read CLAUDE_CODE_* env vars into a ClaudeCodeConfig. Keeps every env
// reference inside the adapter directory.

import path from 'node:path'
import type { ClaudeCodeConfig } from './types.js'
import { defaultAgentDir } from './path-encoding.js'

export function claudeCodeConfigFromEnv(dataDir: string): ClaudeCodeConfig {
  const home = process.env.HOME ?? ''
  return {
    dataDir,
    cwd:
      process.env.CLAUDE_CODE_CWD?.trim() || process.env.SOVEREIGN_WORKSPACE?.trim() || path.join(home, 'workspaces'),
    agentDir: process.env.CLAUDE_CODE_AGENT_DIR?.trim() || defaultAgentDir(home),
    defaultModel: process.env.CLAUDE_CODE_DEFAULT_MODEL?.trim() || undefined
  }
}
