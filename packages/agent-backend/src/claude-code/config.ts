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

export function claudeCodeConfigFromStore(
  configStore: ConfigStore,
  dataDir: string,
  configDir?: string
): ClaudeCodeConfig {
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

  // Inject semble MCP so every Sovereign-spawned session has code search via
  // mcp__semble__search / mcp__semble__find_related without relying on the
  // user's ~/.claude.json (which the SDK's settingSources may not surface).
  // Opt out with SEMBLE_MCP=off; override the launch command with SEMBLE_MCP_CMD.
  const sembleOff = (process.env.SEMBLE_MCP ?? '').trim().toLowerCase() === 'off'
  if (!sembleOff) {
    const cmd = (process.env.SEMBLE_MCP_CMD ?? '').trim()
    if (cmd) {
      const parts = cmd.split(/\s+/)
      mcpServers['semble'] = { type: 'stdio', command: parts[0], args: parts.slice(1) }
    } else {
      mcpServers['semble'] = {
        type: 'stdio',
        command: 'uvx',
        args: ['--from', 'semble[mcp]==0.5.4', 'semble']
      }
    }
  }

  const cwd =
    configStore.get<string>('agentBackend.claudeCode.cwd')?.trim() ||
    configStore.get<string>('workspace.root')?.trim() ||
    path.join(home, 'workspaces')
  const agentDir = configStore.get<string>('agentBackend.claudeCode.agentDir')?.trim() || defaultAgentDir(home)
  const defaultModel = configStore.get<string>('agentBackend.claudeCode.defaultModel')?.trim() || undefined
  const modelContextWindows =
    configStore.get<Record<string, number>>('agentBackend.claudeCode.modelContextWindows') || undefined

  const contextManagement =
    configStore.get<{
      filter?: Record<string, unknown>
      recycle?: Record<string, unknown>
      cleanup?: Record<string, unknown>
    }>('contextManagement') ?? undefined

  // LiteLLM proxy — env vars take precedence over config store so the overlay
  // can be injected per-run (e.g. from a Docker Compose env section or systemd
  // EnvironmentFile) without touching persisted config.
  const litellmUrl =
    process.env.SOVEREIGN_LITELLM_URL?.trim() ||
    configStore.get<string>('agentBackend.claudeCode.litellm.url')?.trim() ||
    undefined
  const litellmApiKey =
    process.env.SOVEREIGN_LITELLM_API_KEY?.trim() ||
    configStore.get<string>('agentBackend.claudeCode.litellm.apiKey')?.trim() ||
    undefined

  return {
    dataDir,
    configDir,
    cwd,
    agentDir,
    defaultModel,
    modelContextWindows,
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    contextManagement,
    litellm: litellmUrl ? { url: litellmUrl, apiKey: litellmApiKey } : undefined
  }
}

/** Return a getter that re-reads Claude Code config from the store on every
 *  call. Backends that accept `() => ClaudeCodeConfig` use this so config
 *  changes take effect without a restart. */
export function claudeCodeConfigGetter(
  configStore: ConfigStore,
  dataDir: string,
  configDir?: string
): () => ClaudeCodeConfig {
  return () => claudeCodeConfigFromStore(configStore, dataDir, configDir)
}
