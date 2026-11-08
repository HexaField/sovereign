// One CLI agent harness, adapted to Sovereign's runner (runner.ts).

import type { HarnessProfile, ModelEndpoint } from '@sovereign/config'
import type { ParsedTurn } from '@sovereign/core'
import type { McpServerSpec } from './mcp.js'

/** The env var a run's endpoint key travels in; per-run configs reference it, never the key. */
export const ENDPOINT_KEY_ENV = 'SOVEREIGN_ENDPOINT_API_KEY'

export interface HarnessRun {
  /** Per-run dir (mode 0700, deleted after the run): the brief and the CLI's config. */
  dir: string
  /** Kept after the run: `<dataDir>/agent-backend/harness/<runId>/`. */
  keepDir: string
  /** The real path the run works in. */
  cwd: string
  briefFile: string
  /** In keepDir: the transcript or last-message file the adapter asks the CLI to write. */
  exportFile: string
  home: string
  bin: string
  profile: HarnessProfile
  /** The spawn's model, else the profile's. */
  model?: string
  endpoint?: ModelEndpoint & { apiKey?: string }
  /** Empty when the profile turns MCP off. */
  mcp: Record<string, McpServerSpec>
  /** Already filtered to the allowlist, with the endpoint key and extraEnv. */
  env: NodeJS.ProcessEnv
}

export interface HarnessCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  /** Fed to the CLI's stdin. */
  stdinFile?: string
}

export interface HarnessAdapter {
  id: HarnessProfile['adapter']
  /** The executable looked up on PATH and in ~/.local/bin. */
  bin: string
  /** Calls a service of its own whatever the endpoint (Devin): never gets a private cwd. */
  remote: boolean
  /** Can use the subagent MCP set. */
  mcp: boolean
  /** Has a sandbox of its own for `sandbox: 'harness'`. */
  ownSandbox: boolean
  /** Home-relative paths the CLI must write under `sandbox: 'bwrap'` (its own state). */
  writable?: string[]
  /** Writes the run's config into `run.dir`; returns the command line. */
  prepare(run: HarnessRun): HarnessCommand
  /** The final report from stdout and/or the export file. */
  report(stdout: string, exportFile: string): string
  /** The run's assistant turns (text, reasoning, tool calls), from stdout and/or the export file;
   *  `at` stands in for times the transcript lacks. Without it, the subagent view shows stdout. */
  transcript?(stdout: string, exportFile: string, at: number): ParsedTurn[]
  /** stdout is the model's text as it writes it (not JSON events): streamed live into the subagent view. */
  textStdout?: boolean
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/** Without ANSI codes and CRs. */
export function plainText(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '')
}

export function requireEndpoint(run: HarnessRun, id: string): ModelEndpoint & { apiKey?: string } {
  if (!run.endpoint) throw new Error(`agents_spawn: harness ${id} needs a profile endpoint (agentBackend.endpoints)`)
  return run.endpoint
}

export function requireModel(run: HarnessRun, id: string): string {
  if (!run.model) throw new Error(`agents_spawn: harness ${id} needs a model (profile model or agents_spawn model)`)
  return run.model
}
