// Read CLAUDE_CODE_* env vars into a ClaudeCodeConfig. Keeps every env
// reference inside the adapter directory.

import fs from 'node:fs'
import path from 'node:path'
import type { ClaudeCodeConfig } from './types.js'
import { defaultAgentDir } from './path-encoding.js'

/** Read the JWT token from the AD4M token file. Returns null if absent/unreadable. */
function readAd4mToken(tokenFile: string): string | null {
  try {
    const raw = fs.readFileSync(tokenFile, 'utf-8')
    return (JSON.parse(raw) as { token?: string }).token ?? null
  } catch {
    return null
  }
}

export function claudeCodeConfigFromEnv(dataDir: string): ClaudeCodeConfig {
  const home = process.env.HOME ?? ''
  const mcpServers: Record<string, unknown> = {}

  // Inject AD4M MCP directly into every Claude Code session so agents get
  // mcp__ad4m__* tools as first-class capabilities — no Sovereign proxy hop.
  // AD4M_MCP_URL: the executor's native MCP endpoint (e.g. http://127.0.0.1:13001/mcp).
  // The JWT token is read from disk so it survives re-auth without a code change.
  const ad4mMcpUrl = process.env.AD4M_MCP_URL?.trim()
  if (ad4mMcpUrl) {
    const tokenFile = path.join(dataDir, 'ad4m-token.json')
    const token = readAd4mToken(tokenFile)
    if (token) {
      mcpServers['ad4m'] = {
        type: 'http',
        url: ad4mMcpUrl,
        headers: { Authorization: `Bearer ${token}` }
      }
    } else {
      console.warn(
        '[sovereign] AD4M_MCP_URL is set but no token found at',
        tokenFile,
        '— skipping MCP injection. Complete AD4M auth first.'
      )
    }
  }

  return {
    dataDir,
    cwd:
      process.env.CLAUDE_CODE_CWD?.trim() || process.env.SOVEREIGN_WORKSPACE?.trim() || path.join(home, 'workspaces'),
    agentDir: process.env.CLAUDE_CODE_AGENT_DIR?.trim() || defaultAgentDir(home),
    defaultModel: process.env.CLAUDE_CODE_DEFAULT_MODEL?.trim() || undefined,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined
  }
}
