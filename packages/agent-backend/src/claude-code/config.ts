// Resolve the Claude Code adapter's config from the Sovereign ConfigStore.

import fs from 'node:fs'
import path from 'node:path'
import type { ConfigStore } from '@sovereign/config'
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

export function claudeCodeConfigFromStore(configStore: ConfigStore, dataDir: string): ClaudeCodeConfig {
  const home = process.env.HOME ?? ''
  const mcpServers: Record<string, unknown> = {}

  // Inject AD4M MCP directly into every Claude Code session so agents get
  // mcp__ad4m__* tools as first-class capabilities — no Sovereign proxy hop.
  const ad4mMcpUrl = configStore.get<string>('ad4m.mcpUrl')?.trim() || ''
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
        '[sovereign] ad4m.mcpUrl is set but no token found at',
        tokenFile,
        '— skipping MCP injection. Complete AD4M auth first.'
      )
    }
  }

  const cwd =
    configStore.get<string>('agentBackend.claudeCode.cwd')?.trim() ||
    configStore.get<string>('workspace.root')?.trim() ||
    path.join(home, 'workspaces')
  const agentDir = configStore.get<string>('agentBackend.claudeCode.agentDir')?.trim() || defaultAgentDir(home)
  const defaultModel = configStore.get<string>('agentBackend.claudeCode.defaultModel')?.trim() || undefined

  return {
    dataDir,
    cwd,
    agentDir,
    defaultModel,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined
  }
}
