// OpenAI Codex CLI. `codex exec … -` with the brief on stdin and a per-run
// CODEX_HOME whose config.toml names a custom provider (`wire_api =
// "responses"`, the only one Codex speaks) and the MCP servers.
// https://learn.chatgpt.com/docs/config-file/config-reference

import fs from 'node:fs'
import path from 'node:path'
import { ENDPOINT_KEY_ENV, requireEndpoint, requireModel, type HarnessAdapter } from '../adapter.js'
import { codexTurns } from '../transcript.js'

type TomlValue = string | boolean | number | string[] | Record<string, string>

function tomlValue(v: TomlValue): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return `[${v.map((s) => JSON.stringify(s)).join(', ')}]`
  const pairs = Object.entries(v).map(([k, s]) => `${JSON.stringify(k)} = ${JSON.stringify(s)}`)
  return pairs.length ? `{ ${pairs.join(', ')} }` : '{}'
}

/**
 * A TOML document: top-level keys, then tables. JSON string escapes are
 * valid TOML basic-string escapes, so strings go through JSON.stringify.
 */
export function tomlConfig(
  top: Array<[string, TomlValue]>,
  tables: Array<[string, Array<[string, TomlValue]>]>
): string {
  const lines = top.map(([k, v]) => `${k} = ${tomlValue(v)}`)
  for (const [name, entries] of tables) {
    lines.push('', `[${name}]`, ...entries.map(([k, v]) => `${k} = ${tomlValue(v)}`))
  }
  return lines.join('\n') + '\n'
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  bin: 'codex',
  remote: false,
  mcp: true,
  ownSandbox: true,

  prepare(run) {
    const endpoint = requireEndpoint(run, 'codex')
    const model = requireModel(run, 'codex')
    if (endpoint.api !== 'openai') throw new Error('agents_spawn: harness codex needs an openai endpoint')
    const home = path.join(run.dir, 'codex')
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    const provider: Array<[string, TomlValue]> = [
      ['name', 'sovereign'],
      ['base_url', endpoint.baseUrl],
      ['wire_api', 'responses']
    ]
    if (endpoint.apiKey) provider.push(['env_key', ENDPOINT_KEY_ENV])
    const tables: Array<[string, Array<[string, TomlValue]>]> = [
      ['sandbox_workspace_write', [['network_access', true]]],
      ['model_providers.sovereign', provider]
    ]
    for (const [name, s] of Object.entries(run.mcp)) {
      tables.push([
        `mcp_servers.${name}`,
        s.type === 'stdio'
          ? [
              ['command', s.command],
              ['args', s.args],
              ['env', s.env]
            ]
          : [['url', s.url], ...(s.headers ? [['http_headers', s.headers] as [string, TomlValue]] : [])]
      ])
    }
    const toml = tomlConfig(
      [
        ['model', model],
        ['model_provider', 'sovereign'],
        ['approval_policy', 'never'],
        // Under bwrap (or none) Sovereign's sandbox is the boundary; 'harness' is Codex's own.
        ['sandbox_mode', run.profile.sandbox === 'harness' ? 'workspace-write' : 'danger-full-access']
      ],
      tables
    )
    fs.writeFileSync(path.join(home, 'config.toml'), toml, { mode: 0o600 })
    return {
      command: run.bin,
      args: [
        'exec',
        '--skip-git-repo-check',
        '--json',
        '-o',
        run.exportFile,
        '-C',
        run.cwd,
        ...(run.profile.extraArgs ?? []),
        '-'
      ],
      env: { ...run.env, CODEX_HOME: home },
      stdinFile: run.briefFile
    }
  },

  report(_stdout, exportFile) {
    try {
      return fs.readFileSync(exportFile, 'utf8').trim()
    } catch {
      return ''
    }
  },

  transcript(stdout, _exportFile, at) {
    return codexTurns(stdout, at)
  }
}
