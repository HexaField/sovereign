import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConfigStore } from '@sovereign/config'
import { claudeCodeConfigFromStore, claudeCodeConfigGetter, resolveCodeEditEntry, withEditRoot } from './config.js'

const store = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigStore

const ENTRY = '/opt/sovereign/packages/code-edit/dist/mcp.js'
const ENV_KEYS = ['CODE_EDIT_MCP', 'SEMBLE_MCP', 'SEMBLE_MCP_CMD', 'CODEGRAPH_MCP', 'CODEGRAPH_MCP_CMD'] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env.SEMBLE_MCP = 'off'
  process.env.CODEGRAPH_MCP = 'off'
  delete process.env.CODE_EDIT_MCP
  delete process.env.SEMBLE_MCP_CMD
  delete process.env.CODEGRAPH_MCP_CMD
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('code-edit MCP injection', () => {
  it('runs the symbol editor on the node running Sovereign, bounded to the cwd and config directory', () => {
    const cfg = claudeCodeConfigFromStore(store({ 'workspace.root': '/w' }), '/data', '/cfg', [], ENTRY)
    expect(cfg.mcpServers?.code).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: ['--liftoff-only', ENTRY, '--edit-roots', `/w${path.delimiter}/cfg`],
      alwaysLoad: true
    })
  })

  it("lets edits reach every org's workspace when the cwd is the config directory", () => {
    // As deployed: sessions start in the config directory; repos live in the org workspaces.
    const orgs = ['/home/x/.sovereign', '/home/x/workspaces/coasys']
    const getConfig = claudeCodeConfigGetter(
      store({ 'agentBackend.claudeCode.cwd': '/home/x/.sovereign' }),
      '/data',
      '/home/x/.sovereign',
      () => orgs,
      ENTRY
    )
    const roots = () => (getConfig().mcpServers!.code as { args: string[] }).args.slice(-1)[0]
    expect(roots()).toBe(['/home/x/.sovereign', '/home/x/workspaces/coasys'].join(path.delimiter))
    orgs.push('/home/x/workspaces/hexafield')
    expect(roots()).toContain('/home/x/workspaces/hexafield')
  })

  it('stays out before the package is built, and when opted out', () => {
    expect(claudeCodeConfigFromStore(store(), '/data', undefined, [], null).mcpServers?.code).toBeUndefined()
    process.env.CODE_EDIT_MCP = 'off'
    expect(claudeCodeConfigFromStore(store(), '/data', undefined, [], ENTRY).mcpServers?.code).toBeUndefined()
  })

  it("resolves the entry to the package's built server script, or null before a build", () => {
    const built = fileURLToPath(new URL('../../../code-edit/dist/mcp.js', import.meta.url))
    expect(resolveCodeEditEntry()).toBe(fs.existsSync(built) ? fs.realpathSync(built) : null)
  })
})

describe('withEditRoot', () => {
  const server = { command: 'node', args: [ENTRY, '--edit-roots', ['/w', '/cfg'].join(path.delimiter)] }

  it('adds a directory outside every root', () => {
    expect(withEditRoot(server, '/tmp/project').args[2]).toBe(['/w', '/cfg', '/tmp/project'].join(path.delimiter))
    expect(server.args[2]).toBe(['/w', '/cfg'].join(path.delimiter))
  })

  it('leaves the roots alone for a directory a root already holds', () => {
    expect(withEditRoot(server, '/w')).toBe(server)
    expect(withEditRoot(server, '/w/repo')).toBe(server)
    expect(withEditRoot(server, '/wx').args[2]).toContain('/wx')
  })
})

describe('MCP launch overrides', () => {
  it('keeps a quoted argument of a custom command whole', () => {
    delete process.env.CODEGRAPH_MCP
    process.env.CODEGRAPH_MCP_CMD = `node "/opt/code graph/index.js" --label 'a b'`
    expect(claudeCodeConfigFromStore(store(), '/data', undefined, [], null).mcpServers?.codegraph).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/opt/code graph/index.js', '--label', 'a b'],
      alwaysLoad: true
    })
  })
})
