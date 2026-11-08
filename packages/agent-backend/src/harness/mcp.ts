// The subagent MCP set in a neutral form, for harnesses other than Claude Code.
// Each adapter translates it into its CLI's own per-run config.

import { subagentMcpServers } from '../claude-code/subagent-runner.js'

export type McpServerSpec =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

/** Claude Code MCP entries (`alwaysLoad`, optional `type`) as neutral specs. */
export function toMcpServerSpecs(entries: Record<string, any>): Record<string, McpServerSpec> {
  const out: Record<string, McpServerSpec> = {}
  for (const [name, e] of Object.entries(entries)) {
    if (e?.url) {
      out[name] = { type: 'http', url: e.url, ...(e.headers ? { headers: { ...e.headers } } : {}) }
    } else if (e?.command) {
      out[name] = { type: 'stdio', command: e.command, args: [...(e.args ?? [])], env: { ...e.env } }
    }
  }
  return out
}

/** The code server's `--edit-roots` set to `cwd` alone: a harness run edits only where it runs. */
function onlyEditRoot(spec: McpServerSpec, cwd: string): McpServerSpec {
  if (spec.type !== 'stdio') return spec
  const i = spec.args.indexOf('--edit-roots')
  if (i === -1) return spec
  const args = [...spec.args]
  args.splice(i + 1, 1, cwd)
  return { ...spec, args }
}

/** The MCP set a harness run in `cwd` gets: Claude subagents' set (codegraph, semble, code, narrow sovereign). */
export function harnessMcpServers(
  configured: Record<string, any>,
  opts: { cwd: string; claudeJsonPath: string }
): Record<string, McpServerSpec> {
  const specs = toMcpServerSpecs(subagentMcpServers(configured, opts))
  if (specs.code) specs.code = onlyEditRoot(specs.code, opts.cwd)
  return specs
}
