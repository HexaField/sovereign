import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConfigStore } from '@sovereign/config'
import { claudeCodeConfigFromStore } from './config.js'

const store = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigStore

const ENV_KEYS = ['PATH', 'GRAPHCODER_MCP', 'GRAPHCODER_MCP_CMD', 'SEMBLE_MCP', 'CODEGRAPH_MCP'] as const
let saved: Record<string, string | undefined>
let bin: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-'))
  process.env.PATH = bin
  process.env.SEMBLE_MCP = 'off'
  process.env.CODEGRAPH_MCP = 'off'
  delete process.env.GRAPHCODER_MCP
  delete process.env.GRAPHCODER_MCP_CMD
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(bin, { recursive: true, force: true })
})

function installGraphcoder(): void {
  const exe = path.join(bin, 'graphcoder-mcp')
  fs.writeFileSync(exe, '#!/bin/sh\n')
  fs.chmodSync(exe, 0o755)
}

describe('graphcoder MCP injection', () => {
  it('registers only the edit tool, bounded to the workspace and config directories', () => {
    installGraphcoder()
    const cfg = claudeCodeConfigFromStore(store({ 'workspace.root': '/w' }), '/data', '/cfg')
    expect(cfg.mcpServers?.graphcoder).toEqual({
      type: 'stdio',
      command: 'graphcoder-mcp',
      args: ['--tools', 'edit', '--edit-roots', `/w${path.delimiter}/cfg`],
      alwaysLoad: true
    })
  })

  it('stays out when graphcoder-mcp is not installed, or when opted out', () => {
    expect(claudeCodeConfigFromStore(store(), '/data').mcpServers?.graphcoder).toBeUndefined()
    installGraphcoder()
    fs.chmodSync(path.join(bin, 'graphcoder-mcp'), 0o644)
    expect(claudeCodeConfigFromStore(store(), '/data').mcpServers?.graphcoder).toBeUndefined()
    fs.chmodSync(path.join(bin, 'graphcoder-mcp'), 0o755)
    process.env.GRAPHCODER_MCP = 'off'
    expect(claudeCodeConfigFromStore(store(), '/data').mcpServers?.graphcoder).toBeUndefined()
  })

  it('launches a custom command and keeps its own arguments first', () => {
    process.env.GRAPHCODER_MCP_CMD = 'node /opt/gc/index.js --verbose'
    const server = claudeCodeConfigFromStore(store({ 'workspace.root': '/w' }), '/data').mcpServers?.graphcoder as {
      command: string
      args: string[]
    }
    expect(server.command).toBe('node')
    expect(server.args).toEqual(['/opt/gc/index.js', '--verbose', '--tools', 'edit', '--edit-roots', '/w'])
  })
})
