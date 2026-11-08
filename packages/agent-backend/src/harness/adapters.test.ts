import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessProfile } from '@sovereign/config'
import { ENDPOINT_KEY_ENV, type HarnessRun } from './adapter.js'
import { codexAdapter, tomlConfig } from './adapters/codex.js'
import { devinAdapter, stripDevinBanner, trustWorkspace } from './adapters/devin.js'
import { opencodeAdapter, opencodeReport } from './adapters/opencode.js'
import { piAdapter } from './adapters/pi.js'
import { harnessMcpServers, toMcpServerSpecs, type McpServerSpec } from './mcp.js'

let tmp: string
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-adapters-')))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

const MCP: Record<string, McpServerSpec> = {
  codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], env: {} },
  code: { type: 'stdio', command: 'node', args: ['mcp.js', '--edit-roots', '/w/repo'], env: { A: 'b' } },
  sovereign: { type: 'http', url: 'http://localhost:5801/api/mcp/subagent' }
}

function run(profile: Partial<HarnessProfile> & Pick<HarnessProfile, 'adapter'>, extra: Partial<HarnessRun> = {}) {
  const dir = path.join(tmp, 'run')
  const keepDir = path.join(tmp, 'keep')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(keepDir, { recursive: true })
  return {
    dir,
    keepDir,
    cwd: '/w/repo',
    briefFile: path.join(dir, 'brief.md'),
    exportFile: path.join(keepDir, 'export'),
    home: path.join(tmp, 'home'),
    bin: '/opt/bin/x',
    profile: { sandbox: 'bwrap', ...profile } as HarnessProfile,
    model: profile.model,
    mcp: MCP,
    env: { PATH: '/usr/bin', HOME: '/h' },
    ...extra
  } satisfies HarnessRun
}

describe('harnessMcpServers', () => {
  it('turns the Claude subagent set into neutral specs, with the cwd as the only edit root', () => {
    const configured = {
      codegraph: { command: 'codegraph', args: ['serve', '--mcp'], alwaysLoad: true },
      code: { type: 'stdio', command: 'node', args: ['mcp.js', '--edit-roots', '/cfg:/orgs'], alwaysLoad: true },
      ad4m: { type: 'http', url: 'http://ad4m' }
    }
    const out = harnessMcpServers(configured, { cwd: '/w/repo', claudeJsonPath: path.join(tmp, 'none.json') })
    expect(out).toEqual({
      codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'], env: {} },
      code: { type: 'stdio', command: 'node', args: ['mcp.js', '--edit-roots', '/w/repo'], env: {} },
      sovereign: { type: 'http', url: 'http://localhost:5801/api/mcp/subagent' }
    })
  })

  it('maps sse and http entries to http, keeping headers', () => {
    expect(toMcpServerSpecs({ a: { type: 'sse', url: 'u', headers: { X: '1' } }, b: { url: 'v' } })).toEqual({
      a: { type: 'http', url: 'u', headers: { X: '1' } },
      b: { type: 'http', url: 'v' }
    })
  })
})

describe('devin adapter', () => {
  it('runs print mode with the executor config, own sandbox, model, export and a per-run MCP config', () => {
    const configFile = path.join(tmp, 'executor.json')
    fs.writeFileSync(configFile, '{}')
    const r = run({ adapter: 'devin', model: 'swe-2-high', sandbox: 'harness', configFile, extraArgs: ['--x'] })
    const cmd = devinAdapter.prepare(r)
    expect(cmd.command).toBe('/opt/bin/x')
    expect(cmd.args).toEqual([
      '--config',
      configFile,
      '-p',
      '--prompt-file',
      r.briefFile,
      '--model',
      'swe-2-high',
      '--sandbox',
      '--export',
      r.exportFile,
      '--x'
    ])
    expect(cmd.env).toEqual({ PATH: '/usr/bin', HOME: '/h', XDG_CONFIG_HOME: path.join(r.dir, 'config') })
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'config', 'devin', 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: {
        codegraph: { command: 'codegraph', args: ['serve', '--mcp'], env: {} },
        code: { command: 'node', args: ['mcp.js', '--edit-roots', '/w/repo'], env: { A: 'b' } },
        sovereign: { url: 'http://localhost:5801/api/mcp/subagent', transport: 'http' }
      }
    })
    // The cwd is trusted in Devin's own trust file.
    const trust = path.join(r.home, '.local', 'share', 'devin', 'cli', 'trusted_workspaces.json')
    expect(JSON.parse(fs.readFileSync(trust, 'utf8')).trusted_paths).toEqual(['/w/repo'])
  })

  it('leaves out --sandbox under bwrap, writes an empty MCP set without MCP, and needs its executor config', () => {
    const configFile = path.join(tmp, 'executor.json')
    fs.writeFileSync(configFile, '{}')
    const r = run({ adapter: 'devin', model: 'swe-2-medium', configFile }, { mcp: {} })
    expect(devinAdapter.prepare(r).args).not.toContain('--sandbox')
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'config', 'devin', 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: {}
    })
    expect(() => devinAdapter.prepare(run({ adapter: 'devin', configFile: path.join(tmp, 'missing.json') }))).toThrow(
      /missing\.json/
    )
    expect(() => devinAdapter.prepare(run({ adapter: 'devin' }))).toThrow(/configFile/)
  })

  it('reports stdout without the login banner', () => {
    expect(devinAdapter.report('Logged in as a@example.com\nOrg: x\n\nFixed.\n', '')).toBe('Fixed.')
  })
})

describe('trustWorkspace', () => {
  it('adds the directory once, keeps other fields, refuses a file it cannot parse', () => {
    const file = path.join(tmp, 'trusted_workspaces.json')
    fs.writeFileSync(file, JSON.stringify({ trusted_paths: ['/old'], other: 1 }))
    trustWorkspace(file, '/a')
    trustWorkspace(file, '/a')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ trusted_paths: ['/old', '/a'], other: 1 })
    expect(fs.readdirSync(tmp)).toEqual(['trusted_workspaces.json'])
    fs.writeFileSync(file, '{ broken')
    expect(() => trustWorkspace(file, '/b')).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
  })
})

describe('stripDevinBanner', () => {
  it('removes the banner and sandbox warning, ANSI codes and CRs', () => {
    const out = [
      'Logged in as alex@example.com',
      'Organization: Example',
      '',
      'Warning: --sandbox always uses the autonomous permission mode.',
      'Fixed the bug.',
      '',
      'Tests pass.'
    ].join('\n')
    expect(stripDevinBanner(out)).toBe('Fixed the bug.\n\nTests pass.')
    expect(stripDevinBanner('\u001b[1mDone\u001b[0m\r\n')).toBe('Done')
    expect(stripDevinBanner('Logged in as alex@example.com\nThe answer')).toBe('The answer')
  })
})

describe('codex adapter', () => {
  const endpoint = { api: 'openai' as const, baseUrl: 'http://studio.example:8080/v1', local: true }

  it('runs codex exec with a per-run CODEX_HOME holding the provider and MCP servers, brief on stdin', () => {
    const r = run(
      { adapter: 'codex', model: 'qwen3', endpoint: 'studio' },
      { endpoint: { ...endpoint, apiKey: 'sk-1' } }
    )
    const cmd = codexAdapter.prepare(r)
    const home = path.join(r.dir, 'codex')
    expect(cmd.args).toEqual(['exec', '--skip-git-repo-check', '--json', '-o', r.exportFile, '-C', '/w/repo', '-'])
    expect(cmd.stdinFile).toBe(r.briefFile)
    expect(cmd.env).toEqual({ PATH: '/usr/bin', HOME: '/h', CODEX_HOME: home })
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8')
    expect(toml).toBe(
      [
        'model = "qwen3"',
        'model_provider = "sovereign"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '',
        '[sandbox_workspace_write]',
        'network_access = true',
        '',
        '[model_providers.sovereign]',
        'name = "sovereign"',
        'base_url = "http://studio.example:8080/v1"',
        'wire_api = "responses"',
        `env_key = "${ENDPOINT_KEY_ENV}"`,
        '',
        '[mcp_servers.codegraph]',
        'command = "codegraph"',
        'args = ["serve", "--mcp"]',
        'env = {}',
        '',
        '[mcp_servers.code]',
        'command = "node"',
        'args = ["mcp.js", "--edit-roots", "/w/repo"]',
        'env = { "A" = "b" }',
        '',
        '[mcp_servers.sovereign]',
        'url = "http://localhost:5801/api/mcp/subagent"',
        ''
      ].join('\n')
    )
    // The key itself never goes into the file.
    expect(toml).not.toContain('sk-1')
  })

  it('uses its own workspace-write sandbox under sandbox harness, and leaves env_key out without a key', () => {
    const r = run({ adapter: 'codex', model: 'm', endpoint: 'studio', sandbox: 'harness' }, { endpoint, mcp: {} })
    codexAdapter.prepare(r)
    const toml = fs.readFileSync(path.join(r.dir, 'codex', 'config.toml'), 'utf8')
    expect(toml).toContain('sandbox_mode = "workspace-write"')
    expect(toml).not.toContain('env_key')
    expect(toml).not.toContain('mcp_servers')
  })

  it('needs an endpoint and a model; reports the last-message file', () => {
    expect(() => codexAdapter.prepare(run({ adapter: 'codex', model: 'm' }))).toThrow(/endpoint/)
    expect(() => codexAdapter.prepare(run({ adapter: 'codex' }, { endpoint }))).toThrow(/model/)
    const last = path.join(tmp, 'last.md')
    fs.writeFileSync(last, 'Fixed.\n')
    expect(codexAdapter.report('{"type":"x"}\n', last)).toBe('Fixed.')
    expect(codexAdapter.report('', path.join(tmp, 'none'))).toBe('')
  })

  it('writes TOML strings with escapes', () => {
    expect(tomlConfig([['a', 'say "hi"\\\n']], [])).toBe('a = "say \\"hi\\"\\\\\\n"\n')
  })
})

describe('opencode adapter', () => {
  const endpoint = { api: 'openai' as const, baseUrl: 'http://studio.example:8080/v1', local: true }

  it('runs opencode run with a per-run config: provider, model, MCP, permissions; data kept as the transcript', () => {
    const r = run(
      { adapter: 'opencode', model: 'qwen3', endpoint: 'studio' },
      { endpoint: { ...endpoint, apiKey: 'sk-1' } }
    )
    fs.writeFileSync(r.briefFile, 'BRIEF')
    const cmd = opencodeAdapter.prepare(r)
    const file = path.join(r.dir, 'opencode.json')
    expect(cmd.args).toEqual(['run', '--format', 'json', '-m', 'sovereign/qwen3', '--dir', '/w/repo', 'BRIEF'])
    expect(cmd.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/h',
      OPENCODE_CONFIG: file,
      XDG_CONFIG_HOME: path.join(r.dir, 'xdg-config'),
      XDG_STATE_HOME: path.join(r.dir, 'xdg-state'),
      XDG_DATA_HOME: path.join(r.keepDir, 'opencode-data')
    })
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(config).toEqual({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      model: 'sovereign/qwen3',
      provider: {
        sovereign: {
          npm: '@ai-sdk/openai-compatible',
          name: 'sovereign',
          options: { baseURL: 'http://studio.example:8080/v1', apiKey: `{env:${ENDPOINT_KEY_ENV}}` },
          models: { qwen3: { name: 'qwen3' } }
        }
      },
      mcp: {
        codegraph: { type: 'local', command: ['codegraph', 'serve', '--mcp'], environment: {}, enabled: true },
        code: {
          type: 'local',
          command: ['node', 'mcp.js', '--edit-roots', '/w/repo'],
          environment: { A: 'b' },
          enabled: true
        },
        sovereign: { type: 'remote', url: 'http://localhost:5801/api/mcp/subagent', enabled: true, oauth: false }
      },
      permission: {
        edit: 'allow',
        webfetch: 'allow',
        bash: {
          '*': 'allow',
          'git commit*': 'deny',
          'git push*': 'deny',
          'git remote*': 'deny',
          'git checkout -b*': 'deny',
          'git switch*': 'deny'
        }
      }
    })
    expect(JSON.stringify(config)).not.toContain('sk-1')
  })

  it('takes the anthropic SDK for an anthropic endpoint, a placeholder key without one, and needs an endpoint', () => {
    const r = run(
      { adapter: 'opencode', model: 'claude-x', endpoint: 'c' },
      { endpoint: { api: 'anthropic', baseUrl: 'https://llm.example/v1', local: false } }
    )
    fs.writeFileSync(r.briefFile, 'B')
    opencodeAdapter.prepare(r)
    const provider = JSON.parse(fs.readFileSync(path.join(r.dir, 'opencode.json'), 'utf8')).provider.sovereign
    expect(provider.npm).toBe('@ai-sdk/anthropic')
    expect(provider.options.apiKey).toBe('none')
    expect(() => opencodeAdapter.prepare(run({ adapter: 'opencode', model: 'm' }))).toThrow(/endpoint/)
  })

  it('reports the text parts of the last assistant message from the JSON events', () => {
    const events = [
      { type: 'step_start', part: { messageID: 'm1' } },
      { type: 'text', part: { type: 'text', messageID: 'm1', text: 'Looking.' } },
      { type: 'tool_use', part: { type: 'tool', messageID: 'm1' } },
      { type: 'text', part: { type: 'text', messageID: 'm2', text: 'Fixed the bug.' } },
      { type: 'text', part: { type: 'text', messageID: 'm2', text: 'Tests pass.' } }
    ]
    const stdout = events.map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n'
    expect(opencodeReport(stdout)).toBe('Fixed the bug.\n\nTests pass.')
    expect(opencodeReport('plain text answer\n')).toBe('plain text answer')
  })

  it('reports error events, which --format json writes to stdout instead of stderr', () => {
    const stdout = [
      { type: 'step_start', part: { type: 'step-start', messageID: 'm1' } },
      { type: 'error', error: { name: 'APIError', data: { message: 'context size exceeded' } } },
      { type: 'error', error: { name: 'UnknownError' } }
    ]
      .map((e) => JSON.stringify(e))
      .join('\n')
    expect(opencodeReport(stdout)).toBe('OpenCode error: context size exceeded\n\nOpenCode error: UnknownError')
  })
})

describe('pi adapter', () => {
  const endpoint = { api: 'openai' as const, baseUrl: 'http://studio.example:8080/v1', local: true }

  it('runs pi in print mode with a per-run agent dir holding the provider', () => {
    const r = run(
      { adapter: 'pi', model: 'qwen3', endpoint: 'studio', extraArgs: ['--thinking', 'off'] },
      { endpoint: { ...endpoint, apiKey: 'sk-1' } }
    )
    const cmd = piAdapter.prepare(r)
    const agentDir = path.join(r.dir, 'pi')
    expect(cmd.args).toEqual([
      '-p',
      '--provider',
      'sovereign',
      '--model',
      'qwen3',
      '--session-dir',
      path.join(r.keepDir, 'sessions'),
      '--no-context-files',
      '--thinking',
      'off',
      `@${r.briefFile}`,
      'Carry out the task in the brief above.'
    ])
    expect(cmd.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/h',
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_TELEMETRY: '0'
    })
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'))).toEqual({
      providers: {
        sovereign: {
          baseUrl: 'http://studio.example:8080/v1',
          api: 'openai-completions',
          apiKey: ENDPOINT_KEY_ENV,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: 'qwen3' }]
        }
      }
    })
    expect(piAdapter.mcp).toBe(false)
  })

  it('speaks anthropic-messages to an anthropic endpoint, needs an endpoint, reports stdout', () => {
    const r = run(
      { adapter: 'pi', model: 'm', endpoint: 'c' },
      { endpoint: { api: 'anthropic', baseUrl: 'https://llm.example', local: false } }
    )
    piAdapter.prepare(r)
    const provider = JSON.parse(fs.readFileSync(path.join(r.dir, 'pi', 'models.json'), 'utf8')).providers.sovereign
    expect(provider.api).toBe('anthropic-messages')
    expect(provider.apiKey).toBe('none')
    expect(() => piAdapter.prepare(run({ adapter: 'pi', model: 'm' }))).toThrow(/endpoint/)
    expect(piAdapter.report('\u001b[1mFixed.\u001b[0m\n', '')).toBe('Fixed.')
  })
})
