// Devin CLI (Cognition). `devin --config <executor.json> -p --prompt-file …`.
// Always talks to Cognition's service, under the Devin login: no endpoints.
// MCP: XDG_CONFIG_HOME=<run dir>/config makes it read
// <run dir>/config/devin/mcp_config.json instead of the user's.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { plainText, type HarnessAdapter } from '../adapter.js'
import { atifTurns } from '../transcript.js'

/** The last non-empty agent message in Devin's ATIF export, if it has one. */
function lastAgentMessage(exportFile: string): string | undefined {
  try {
    const steps = JSON.parse(fs.readFileSync(exportFile, 'utf8'))?.steps
    if (!Array.isArray(steps)) return undefined
    for (let i = steps.length - 1; i >= 0; i--) {
      const m = steps[i]?.source === 'agent' ? steps[i].message : undefined
      if (typeof m === 'string' && m.trim()) return m.trim()
    }
  } catch {
    /* no export: fall back to stdout */
  }
  return undefined
}

/** Add `dir` to Devin's workspace trust file (`{ trusted_paths: [...] }`), atomically, keeping every other entry. */
export function trustWorkspace(trustFile: string, dir: string): void {
  let data: { trusted_paths?: string[]; [k: string]: unknown } = {}
  if (fs.existsSync(trustFile)) data = JSON.parse(fs.readFileSync(trustFile, 'utf8'))
  const paths = Array.isArray(data.trusted_paths) ? data.trusted_paths : []
  if (paths.includes(dir)) return
  fs.mkdirSync(path.dirname(trustFile), { recursive: true })
  const tmp = `${trustFile}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...data, trusted_paths: [...paths, dir] }, null, 2) + '\n')
  fs.renameSync(tmp, trustFile)
}

const SANDBOX_WARNING_RE = /^Warning: --sandbox always uses /

/**
 * The answer in `devin -p` stdout: without the login banner ("Logged in as …"
 * up to the first blank line), the sandbox warning, ANSI codes and CRs.
 */
export function stripDevinBanner(stdout: string): string {
  const lines = plainText(stdout).split('\n')
  let i = 0
  for (;;) {
    while (i < lines.length && lines[i].trim() === '') i++
    if (i >= lines.length) break
    if (SANDBOX_WARNING_RE.test(lines[i])) {
      i++
    } else if (lines[i].startsWith('Logged in as ')) {
      const blank = lines.findIndex((l, j) => j > i && l.trim() === '')
      // Banner lines carry no sentences; without a blank line only the login line goes.
      i = blank !== -1 && blank - i <= 4 ? blank : i + 1
    } else break
  }
  return lines.slice(i).join('\n').trim()
}

function expandHome(p: string, home: string): string {
  return p.replace(/^~(?=\/|$)/, home)
}

export const devinAdapter: HarnessAdapter = {
  id: 'devin',
  bin: 'devin',
  remote: true,
  mcp: true,
  ownSandbox: true,
  writable: ['.local/share/devin', '.cache/devin'],

  prepare(run) {
    if (!run.profile.configFile) {
      throw new Error('agents_spawn: harness devin needs a configFile (the locked-down executor config)')
    }
    if (run.endpoint) throw new Error('agents_spawn: harness devin takes no endpoint (it runs on the Devin login)')
    const configFile = expandHome(run.profile.configFile, run.home)
    if (!fs.existsSync(configFile)) throw new Error(`agents_spawn: devin executor config ${configFile} is missing`)
    if (!run.model) throw new Error('agents_spawn: harness devin needs a model')

    const configHome = path.join(run.dir, 'config')
    fs.mkdirSync(path.join(configHome, 'devin'), { recursive: true })
    const mcpServers: Record<string, unknown> = {}
    for (const [name, s] of Object.entries(run.mcp)) {
      mcpServers[name] =
        s.type === 'stdio'
          ? { command: s.command, args: s.args, env: s.env }
          : { url: s.url, transport: 'http', ...(s.headers ? { headers: s.headers } : {}) }
    }
    fs.writeFileSync(path.join(configHome, 'devin', 'mcp_config.json'), JSON.stringify({ mcpServers }, null, 2), {
      mode: 0o600
    })
    trustWorkspace(path.join(run.home, '.local', 'share', 'devin', 'cli', 'trusted_workspaces.json'), run.cwd)

    return {
      command: run.bin,
      args: [
        '--config',
        configFile,
        '-p',
        '--prompt-file',
        run.briefFile,
        '--model',
        run.model,
        ...(run.profile.sandbox === 'harness' ? ['--sandbox'] : []),
        // `--export` writes the transcript as ATIF JSON, whatever the file name.
        '--export',
        run.exportFile,
        ...(run.profile.extraArgs ?? [])
      ],
      env: { ...run.env, XDG_CONFIG_HOME: configHome }
    }
  },

  // stdout runs every progress remark into the report with no line break;
  // the export holds the final agent message on its own.
  report(stdout, exportFile) {
    return lastAgentMessage(exportFile) ?? stripDevinBanner(stdout)
  },

  // The export is written when the run ends; until then the view streams stdout.
  transcript(_stdout, exportFile) {
    return atifTurns(exportFile)
  },

  textStdout: true
}
