// OpenCode (1.19). `opencode run --format json -m sovereign/<model> <brief>`
// with OPENCODE_CONFIG pointing at a per-run opencode.json: one provider
// (`@ai-sdk/openai-compatible` or `@ai-sdk/anthropic`), the MCP servers and
// permission rules. XDG config/state go to the run dir; XDG data (its session
// database) to the kept dir, as the transcript. The package cache stays in ~/.cache.
// https://opencode.ai/docs/config/ https://opencode.ai/docs/providers/ https://opencode.ai/docs/mcp-servers/

import fs from 'node:fs'
import path from 'node:path'
import { ENDPOINT_KEY_ENV, plainText, requireEndpoint, requireModel, type HarnessAdapter } from '../adapter.js'
import { opencodeTurns } from '../transcript.js'

/**
 * The final answer in `--format json` output: the text parts of the last
 * message that has any, then any error events (JSON mode writes those to
 * stdout, not stderr). Output that is not JSON events comes back as is.
 */
export function opencodeReport(stdout: string): string {
  const texts: Array<{ message: string; text: string }> = []
  const errors: string[] = []
  let events = 0
  for (const line of plainText(stdout).split('\n')) {
    let e: any
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    events++
    if (e?.type === 'text' && typeof e.part?.text === 'string') {
      texts.push({ message: String(e.part.messageID ?? ''), text: e.part.text })
    } else if (e?.type === 'error') {
      errors.push(`OpenCode error: ${String(e.error?.data?.message ?? e.error?.name ?? 'unknown')}`)
    }
  }
  if (!events) return plainText(stdout).trim()
  const last = texts[texts.length - 1]?.message
  return [
    ...texts
      .filter((t) => t.message === last)
      .map((t) => t.text.trim())
      .filter(Boolean),
    ...errors
  ].join('\n\n')
}

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  bin: 'opencode',
  remote: false,
  mcp: true,
  ownSandbox: false,

  prepare(run) {
    const endpoint = requireEndpoint(run, 'opencode')
    const model = requireModel(run, 'opencode')
    const mcp: Record<string, unknown> = {}
    for (const [name, s] of Object.entries(run.mcp)) {
      mcp[name] =
        s.type === 'stdio'
          ? { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true }
          : { type: 'remote', url: s.url, ...(s.headers ? { headers: s.headers } : {}), enabled: true, oauth: false }
    }
    const config = {
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      model: `sovereign/${model}`,
      provider: {
        sovereign: {
          npm: endpoint.api === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
          name: 'sovereign',
          // The key is read from the env at run time, never written here.
          options: { baseURL: endpoint.baseUrl, apiKey: endpoint.apiKey ? `{env:${ENDPOINT_KEY_ENV}}` : 'none' },
          models: { [model]: { name: model } }
        }
      },
      mcp,
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
    }
    const file = path.join(run.dir, 'opencode.json')
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 })
    const dataHome = path.join(run.keepDir, 'opencode-data')
    fs.mkdirSync(dataHome, { recursive: true })
    return {
      command: run.bin,
      args: [
        'run',
        '--format',
        'json',
        '-m',
        `sovereign/${model}`,
        '--dir',
        run.cwd,
        ...(run.profile.extraArgs ?? []),
        // One argument (well under Linux's 128 KiB per-argument limit: the brief caps the repo context at 40k).
        fs.readFileSync(run.briefFile, 'utf8')
      ],
      env: {
        ...run.env,
        OPENCODE_CONFIG: file,
        XDG_CONFIG_HOME: path.join(run.dir, 'xdg-config'),
        XDG_STATE_HOME: path.join(run.dir, 'xdg-state'),
        XDG_DATA_HOME: dataHome
      }
    }
  },

  report(stdout) {
    return opencodeReport(stdout)
  },

  transcript(stdout) {
    return opencodeTurns(stdout)
  }
}
