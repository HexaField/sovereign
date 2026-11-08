// The runner for `agents_spawn` harnesses other than Claude Code (Devin,
// Codex, OpenCode, Pi): one non-interactive CLI process per run, configured
// per run by its adapter (adapters/*.ts). It emits a Claude Code subagent's
// events (session.info, subagent.spawned, chat.stream/turn/status, then
// subagent.completed or subagent.failed with the parent's [Subagent done: …]
// / [Subagent failed: …] message), and keeps each run's record (run.json)
// and transcript, so the subagent view can show it (backend.ts).
//
// The rules it enforces for every harness:
// 1. The cwd's real path lies under the profile's allowedRoots, and never in a
//    private directory (~/.sovereign, ~/workspaces/hexafield, Sovereign's data
//    and config dirs) unless the endpoint is local and the harness calls no
//    service of its own.
// 2. The env is an allowlist, plus the endpoint key (from the secret store,
//    under ENDPOINT_KEY_ENV), plus the profile's extraEnv.
// 3. `sandbox: 'bwrap'` runs the CLI read-only over / with credential and
//    private paths masked; cwd, the run dirs, /tmp and ~/.cache stay
//    writable. Under `sandbox: 'harness'` the CLI's own sandbox covers its
//    commands, so the stdio MCP servers it starts are wrapped in bwrap.
// 4. The brief forbids commits, pushes, remotes and branch changes.
// 5. Own process group; TERM then KILL after 5 s; timeout = profile, else the
//    spawn's, else 4 h; runs persisted so a restart reports them failed;
//    at most 4 running per parent.
// 6. The transcript stays in <dataDir>/agent-backend/harness/<runId>/; the
//    brief and the per-run config dir are deleted.

import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HarnessProfile, ModelEndpoint } from '@sovereign/config'
import { formatSubagentResult, type AgentBackendEvents, type ParsedTurn } from '@sovereign/core'
import { createBackendEmitter } from '@sovereign/primitives'
import type { ActiveSessions } from '../active-sessions.js'
import {
  buildSubagentSystemPrompt,
  MAX_SUBAGENTS_PER_PARENT,
  SUBAGENT_TIMEOUT_MS
} from '../claude-code/subagent-runner.js'
import { ENDPOINT_KEY_ENV, plainText, type HarnessAdapter } from './adapter.js'
import { codexAdapter } from './adapters/codex.js'
import { devinAdapter } from './adapters/devin.js'
import { opencodeAdapter } from './adapters/opencode.js'
import { piAdapter } from './adapters/pi.js'
import type { McpServerSpec } from './mcp.js'

export const HARNESS_ADAPTERS: Record<string, HarnessAdapter> = {
  devin: devinAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter
}

/** Never a harness cwd unless the run stays local: Sovereign's own data and the private repos. */
export const PRIVATE_ROOTS = ['~/.sovereign', '~/workspaces/hexafield']

/** Credentials and logins, masked under bwrap (home-relative). */
const CREDENTIAL_PATHS = [
  '.ssh',
  '.gnupg',
  '.config/gh',
  '.git-credentials',
  '.netrc',
  '.aws',
  '.config/gcloud',
  '.docker',
  '.npmrc',
  '.claude',
  '.claude.json',
  '.sovereign',
  '.config/sovereign',
  '.codex',
  '.pi',
  '.local/share/opencode',
  '.config/opencode',
  '.local/share/devin',
  '.config/devin'
]

const PASSED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ']
const PASSED_ENV_PREFIXES = ['XDG_']

/** stdout kept per run (the answer); stderr kept for the failure message. */
const MAX_STDOUT = 2_000_000
const STDERR_TAIL = 4_000
/** After SIGTERM to the process group, SIGKILL if it still runs. */
const KILL_GRACE_MS = 5_000

function expandHome(p: string, home: string): string {
  return p.replace(/^~(?=\/|$)/, home)
}

/** The real path of `p`, or its resolved path when it does not exist. */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function isInside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

/**
 * The real path of a run's cwd, or an error. The check runs on the real path,
 * so neither `..` nor a symlink leads out of an allowed root or into a private one.
 */
export function resolveHarnessCwd(
  cwd: string,
  opts: { home: string; name: string; allowedRoots: string[]; deniedRoots?: string[]; privateOk?: boolean }
): string {
  const resolved = path.resolve(expandHome(cwd, opts.home))
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    throw new Error(`agents_spawn: cwd ${resolved} is not a directory`)
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`agents_spawn: cwd ${resolved} is not a directory`)
  if (!opts.privateOk) {
    const denied = [...PRIVATE_ROOTS, ...(opts.deniedRoots ?? [])].map((r) => realOrResolved(expandHome(r, opts.home)))
    if (denied.some((root) => isInside(real, root))) {
      throw new Error(
        `agents_spawn: harness ${opts.name} may not run in ${real}: private directory (only a local endpoint may see it)`
      )
    }
  }
  const allowed = opts.allowedRoots.filter(Boolean).map((r) => realOrResolved(expandHome(r, opts.home)))
  if (!allowed.some((root) => isInside(real, root))) {
    throw new Error(
      `agents_spawn: harness ${opts.name} may not run in ${real}: not under agentBackend.harnesses.${opts.name}.allowedRoots (${opts.allowedRoots.join(', ') || 'none'})`
    )
  }
  return real
}

/** The env vars a run inherits from the server: nothing else (tokens, the SSH agent socket) passes. */
export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env))
    if (PASSED_ENV.includes(key) || PASSED_ENV_PREFIXES.some((p) => key.startsWith(p))) out[key] = value
  return out
}

/** `name` on PATH, else in ~/.local/bin (often off a service's PATH); null when absent. */
export function findBinary(name: string, pathEnv: string | undefined, home: string): string | null {
  const dirs = [...(pathEnv ?? '').split(path.delimiter).filter(Boolean), path.join(home, '.local', 'bin')]
  for (const dir of dirs) {
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* not here */
    }
  }
  return null
}

/**
 * bwrap options (before the command): / read-only, credentials and `hidden`
 * masked by an empty tmpfs (a file by /dev/null), then ~/.cache, the
 * adapter's own state, cwd and `writable` bound writable and `readable`
 * re-exposed read-only. Only existing paths are mounted over. The network
 * stays open: the endpoint and MCP over localhost need it.
 */
export function bwrapArgs(opts: {
  home: string
  cwd: string
  writable: string[]
  hidden: string[]
  adapterWritable?: string[]
  readable?: string[]
}): string[] {
  const own = (opts.adapterWritable ?? []).map((p) => path.join(opts.home, p))
  let backups: string[] = []
  try {
    backups = fs
      .readdirSync(opts.home)
      .filter((f) => f.startsWith('sovereign-backup-'))
      .map((f) => path.join(opts.home, f))
  } catch {
    /* no home */
  }
  const masked = [...new Set([...CREDENTIAL_PATHS.map((p) => path.join(opts.home, p)), ...backups, ...opts.hidden])]
  const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--bind', '/tmp', '/tmp']
  for (const p of masked) {
    if (own.includes(p)) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(p)
    } catch {
      continue
    }
    if (stat.isDirectory()) args.push('--tmpfs', p)
    else args.push('--ro-bind', '/dev/null', p)
  }
  const binds = [path.join(opts.home, '.cache'), ...own, opts.cwd, ...opts.writable]
  for (const p of binds) if (fs.existsSync(p)) args.push('--bind', p, p)
  for (const p of opts.readable ?? []) if (fs.existsSync(p)) args.push('--ro-bind', p, p)
  args.push('--chdir', opts.cwd)
  return args
}

/** The brief: what a harness run needs beyond the subagent prompt, then that prompt, then the task. */
export function buildHarnessBrief(opts: {
  adapter: string
  systemPrompt: string
  task: string
  mcp: string[]
}): string {
  return [
    `# Running as a Sovereign subagent through ${opts.adapter}`,
    '',
    'The rules below come from the brief every Sovereign subagent gets. Where they name a tool you do not have, ' +
      'use your own tools. Hard rules:',
    '- You never commit, push, add remotes, create or switch branches. Leave changes in the working tree.',
    '- No destructive actions outside the working directory.',
    '- Your final message is the report: what you changed (paths), commands run with results, what is left open.',
    opts.mcp.length
      ? `- MCP servers: ${opts.mcp.join(', ')} (tools named mcp__<server>__<tool> or <server>_<tool>, depending on your harness). The browser tools are not available.`
      : '- No MCP servers are available to you (codegraph, semble, mcp__code__edit, Sovereign tools): use your own tools.',
    '',
    opts.systemPrompt,
    '',
    '# Task',
    '',
    opts.task
  ].join('\n')
}

/** One line per profile for the agents_spawn description. */
export function describeProfiles(
  profiles: Record<string, HarnessProfile>,
  endpoints: Record<string, ModelEndpoint>,
  adapters: Record<string, HarnessAdapter> = HARNESS_ADAPTERS
): string[] {
  return Object.entries(profiles).map(([name, p]) => {
    if (p.adapter === 'claude') return `${name}: Claude Code (default subagent), cloud, MCP yes`
    const mcp = p.mcp !== false && adapters[p.adapter]?.mcp !== false ? 'yes' : 'no'
    const model = p.model ? `, model ${p.model}` : ''
    const where = p.endpoint
      ? `endpoint ${p.endpoint} (${endpoints[p.endpoint] ? (endpoints[p.endpoint].local ? 'local' : 'cloud') : 'not configured'})`
      : p.adapter === 'devin'
        ? 'Devin login (cloud)'
        : 'no endpoint'
    return `${name}: ${p.adapter}${model}, ${where}, MCP ${mcp}`
  })
}

export interface HarnessSpawnOptions {
  /** A profile name in agentBackend.harnesses (not a claude one). */
  harness: string
  task: string
  cwd?: string
  label?: string
  /** Overrides the profile's model. */
  model?: string
  /** Used when the profile sets no timeoutMinutes. */
  timeoutMs?: number
}

export interface HarnessRunSummary {
  sessionKey: string
  parentKey: string
  label: string
  status: 'working'
  harness: string
  task: string
  cwd: string
  model?: string
  startedAt: number
}

/** A run's record, kept in `<runId>/run.json` after it ends. */
export interface HarnessRunRecord extends Omit<HarnessRunSummary, 'status'> {
  status: 'working' | 'completed' | 'failed'
  adapter: HarnessAdapter['id']
  endedAt?: number
  /** The report (the adapter's final answer). */
  answer?: string
  error?: string
  ended?: 'stopped' | 'timed-out'
  stderrTail?: string
}

export interface HarnessRunner {
  /** Start a run; returns its key at once. Its subagent.completed / subagent.failed carries the parent's message. */
  spawn(parentKey: string, opts: HarnessSpawnOptions): Promise<string>
  /** Running runs (finished ones drop out). */
  list(parentKey?: string): HarnessRunSummary[]
  has(key: string): boolean
  /** End a run: kills its process group; the parent gets a failure message. */
  stop(key: string): Promise<void>
  /** One line per configured profile (agents_spawn's description). */
  describe(): string[]
  /** Tell parents about runs a restart cut off (left in runs.json). Call once the parent delivery is wired. */
  recoverInterrupted(): void
  /** Kill every run without telling parents: shutdown. The next boot's recoverInterrupted tells them. */
  dispose(): void
  /** Every run with a record, running or ended, newest first. */
  records(parentKey?: string): HarnessRunRecord[]
  record(key: string): HarnessRunRecord | null
  /** The run as turns: the task, the transcript (else stdout), the report, the failure. Null for an unknown key. */
  history(key: string): ParsedTurn[] | null
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
}

export interface HarnessRunnerOptions {
  dataDir: string
  home: string
  /** Sovereign config dir: SUBAGENT.md, and private. */
  configDir?: string
  /** Read at every spawn, so a config change applies to the next run. */
  profiles: () => Record<string, HarnessProfile>
  endpoints: () => Record<string, ModelEndpoint>
  /** A secret store value by name. */
  secret: (name: string) => string | undefined
  /** The subagent MCP set for a run in `cwd`. */
  mcpServers: (cwd: string) => Record<string, McpServerSpec>
  /** Tracks each run under its parent, as for a Claude Code subagent. */
  activeSessions?: Pick<ActiveSessions, 'addSubagent' | 'removeSubagent'>
  /** Where to look for the CLIs and bwrap; default the process PATH. */
  pathEnv?: string
  /** The child's environment before filtering; default the process env. */
  env?: NodeJS.ProcessEnv
  /** Default HARNESS_ADAPTERS. */
  adapters?: Record<string, HarnessAdapter>
}

interface Run extends HarnessRunSummary {
  adapter: HarnessAdapter
  child: ChildProcess
  runDir: string
  keepDir: string
  exportFile: string
  stdout: string
  stderr: string
  /** Set when the run was cut off rather than ending on its own. */
  ended?: string
  endedKind?: 'stopped' | 'timed-out'
  disposed?: boolean
  timer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
}

/** Every live harness process group, killed when Sovereign's process exits. */
const liveGroups = new Set<number>()
let exitHookInstalled = false
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    /* already gone */
  }
}
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const pid of liveGroups) killGroup(pid, 'SIGTERM')
  })
}

export function createHarnessRunner(opts: HarnessRunnerOptions): HarnessRunner {
  const adapters = opts.adapters ?? HARNESS_ADAPTERS
  const baseDir = path.join(opts.dataDir, 'agent-backend', 'harness')
  const runsFile = path.join(baseDir, 'runs.json')
  const runs = new Map<string, Run>()
  const pathEnv = () => opts.pathEnv ?? process.env.PATH

  type Persisted = Pick<HarnessRunSummary, 'sessionKey' | 'parentKey' | 'label' | 'startedAt'>
  function readPersisted(): Persisted[] {
    try {
      return JSON.parse(fs.readFileSync(runsFile, 'utf8'))
    } catch {
      return []
    }
  }
  function persist(): void {
    fs.mkdirSync(baseDir, { recursive: true })
    const list: Persisted[] = [...runs.values()].map(({ sessionKey, parentKey, label, startedAt }) => ({
      sessionKey,
      parentKey,
      label,
      startedAt
    }))
    const tmp = `${runsFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, runsFile)
  }

  const emitter = createBackendEmitter('harness')
  const turn = (role: ParsedTurn['role'], content: string, timestamp: number): ParsedTurn => ({
    role,
    content,
    timestamp,
    workItems: [],
    thinkingBlocks: []
  })

  const recordFile = (key: string) => path.join(baseDir, key, 'run.json')
  function readRecord(key: string): HarnessRunRecord | null {
    // Keys come from routes: only a run id names a run dir.
    if (!/^harness-[0-9a-f-]+$/.test(key)) return null
    try {
      return JSON.parse(fs.readFileSync(recordFile(key), 'utf8'))
    } catch {
      return null
    }
  }
  function writeRecord(record: HarnessRunRecord): void {
    const file = recordFile(record.sessionKey)
    if (!fs.existsSync(path.dirname(file))) return
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2))
    fs.renameSync(tmp, file)
  }
  function liveRecord(run: Run): HarnessRunRecord {
    const { sessionKey, parentKey, label, harness, task, cwd, model, startedAt } = run
    return {
      sessionKey,
      parentKey,
      label,
      harness,
      task,
      cwd,
      model,
      startedAt,
      adapter: run.adapter.id,
      status: 'working'
    }
  }

  function recordOf(key: string): HarnessRunRecord | null {
    const run = runs.get(key)
    return run ? liveRecord(run) : readRecord(key)
  }

  function failureTurn(record: HarnessRunRecord): ParsedTurn {
    const tail = record.stderrTail && !record.ended ? `\n\nstderr (tail):\n\n\`\`\`\n${record.stderrTail}\n\`\`\`` : ''
    return {
      ...turn('system', `Run finished with an error: ${record.error}${tail}`, record.endedAt ?? Date.now()),
      kind: { variant: 'agent-error', label: 'Subagent failed' }
    }
  }

  function finish(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
    if (!runs.has(run.sessionKey)) return
    runs.delete(run.sessionKey)
    if (run.timer) clearTimeout(run.timer)
    if (run.killTimer) clearTimeout(run.killTimer)
    if (run.child.pid) liveGroups.delete(run.child.pid)
    // The per-run dir holds the brief and the CLI's config: it goes.
    fs.rmSync(run.runDir, { recursive: true, force: true })
    if (run.disposed) return
    persist()
    fs.writeFileSync(path.join(run.keepDir, 'output.log'), run.stdout)
    if (run.stderr.trim()) fs.writeFileSync(path.join(run.keepDir, 'stderr.log'), run.stderr)
    let answer = ''
    try {
      answer = run.adapter.report(run.stdout, run.exportFile)
    } catch (err) {
      run.stderr += `\nreport: ${String(err)}`
    }
    const stderrTail = run.stderr.trim().slice(-STDERR_TAIL)
    let error: string | undefined
    let body = answer
    if (run.ended) error = run.ended
    else if (code !== 0)
      error = signal ? `${run.adapter.id} ended on ${signal}` : `${run.adapter.id} exited with code ${code}`
    else if (!answer) error = 'ended without a result'
    // A failure the CLI explains only on stderr (an HTTP error, a full context window).
    if (error && !run.ended && stderrTail) {
      body = [answer, `stderr (tail):\n\n\`\`\`\n${stderrTail}\n\`\`\``].filter(Boolean).join('\n\n')
    }
    body = [body, `Transcript: ${run.keepDir}`].filter(Boolean).join('\n\n')
    const endedAt = Date.now()
    const durationMs = endedAt - run.startedAt
    const record: HarnessRunRecord = {
      ...liveRecord(run),
      status: error ? 'failed' : 'completed',
      endedAt,
      ...(answer ? { answer } : {}),
      ...(error ? { error } : {}),
      ...(run.endedKind ? { ended: run.endedKind } : {}),
      ...(error && stderrTail ? { stderrTail } : {})
    }
    writeRecord(record)

    const sessionKey = run.sessionKey
    if (answer) emitter.emit('chat.turn', { sessionKey, turn: turn('assistant', answer, endedAt) })
    if (error) emitter.emit('chat.turn', { sessionKey, turn: failureTurn(record) })
    emitter.emit('chat.status', { sessionKey, status: 'idle' })
    const parentMessage = formatSubagentResult({ label: run.label, sessionKey, durationMs, result: body, error })
    const about = { parentKey: run.parentKey, childKey: sessionKey, label: run.label, durationMs }
    if (error) {
      emitter.emit('subagent.failed', {
        ...about,
        error,
        parentMessage,
        ...(run.endedKind ? { ended: run.endedKind } : {})
      })
    } else {
      emitter.emit('subagent.completed', { ...about, result: answer, parentMessage })
    }
    opts.activeSessions?.removeSubagent(run.parentKey, sessionKey)
  }

  /** Cut a run off: SIGTERM to its process group, SIGKILL after a grace period. */
  function cutOff(run: Run, reason: string, kind: 'stopped' | 'timed-out'): void {
    if (run.ended) return
    run.ended = reason
    run.endedKind = kind
    const pid = run.child.pid
    if (!pid) return
    killGroup(pid, 'SIGTERM')
    run.killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS)
    run.killTimer.unref?.()
  }

  return {
    async spawn(parentKey, o) {
      const profiles = opts.profiles()
      const profile = profiles[o.harness]
      if (!profile) {
        throw new Error(
          `agents_spawn: unknown harness ${o.harness} (configured: ${Object.keys(profiles).join(', ') || 'none'})`
        )
      }
      const adapter = adapters[profile.adapter]
      if (!adapter)
        throw new Error(
          `agents_spawn: harness ${o.harness} (adapter ${profile.adapter}) runs as a claude subagent, not here`
        )
      const running = [...runs.values()].filter((r) => r.parentKey === parentKey).length
      if (running >= MAX_SUBAGENTS_PER_PARENT) {
        throw new Error(
          `agents_spawn: ${running} harness runs already run for this thread (max ${MAX_SUBAGENTS_PER_PARENT}); wait for one to finish`
        )
      }
      if (!o.cwd) throw new Error(`agents_spawn: harness ${o.harness} needs a cwd under its allowedRoots`)

      let endpoint: (ModelEndpoint & { apiKey?: string }) | undefined
      if (profile.endpoint) {
        const ep = opts.endpoints()[profile.endpoint]
        if (!ep)
          throw new Error(
            `agents_spawn: harness ${o.harness} names endpoint ${profile.endpoint}, which agentBackend.endpoints lacks`
          )
        endpoint = { ...ep }
        if (ep.apiKeySecret) {
          const key = opts.secret(ep.apiKeySecret)
          if (!key)
            throw new Error(`agents_spawn: secret ${ep.apiKeySecret} for endpoint ${profile.endpoint} is not set`)
          endpoint.apiKey = key
        }
      }
      const cwd = resolveHarnessCwd(o.cwd, {
        home: opts.home,
        name: o.harness,
        allowedRoots: profile.allowedRoots ?? [],
        deniedRoots: [opts.dataDir, ...(opts.configDir ? [opts.configDir] : [])],
        privateOk: !!endpoint?.local && !adapter.remote
      })
      const sandbox = profile.sandbox ?? 'bwrap'
      if (sandbox === 'harness' && !adapter.ownSandbox) {
        throw new Error(
          `agents_spawn: harness ${o.harness}: ${adapter.id} has no sandbox of its own (use sandbox bwrap)`
        )
      }
      const bin = profile.bin ? expandHome(profile.bin, opts.home) : findBinary(adapter.bin, pathEnv(), opts.home)
      if (!bin) throw new Error(`agents_spawn: the ${adapter.bin} CLI was not found (PATH, ~/.local/bin)`)
      const bwrap = sandbox === 'none' ? null : findBinary('bwrap', pathEnv(), opts.home)
      if (sandbox !== 'none' && !bwrap)
        throw new Error(`agents_spawn: bwrap was not found; harness ${o.harness} needs it`)

      const key = `harness-${randomUUID()}`
      const model = o.model || profile.model
      const label = o.label ?? o.task.slice(0, 60)
      const keepDir = path.join(baseDir, key)
      fs.mkdirSync(keepDir, { recursive: true })
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-harness-'))
      fs.chmodSync(runDir, 0o700)
      const cleanUp = () => {
        fs.rmSync(runDir, { recursive: true, force: true })
        fs.rmSync(keepDir, { recursive: true, force: true })
      }

      const hidden = [
        opts.dataDir,
        ...(opts.configDir ? [opts.configDir] : []),
        ...(endpoint?.local && !adapter.remote ? [] : PRIVATE_ROOTS.map((r) => expandHome(r, opts.home)))
      ]
      const configFile = profile.configFile ? expandHome(profile.configFile, opts.home) : undefined
      const sandboxArgs = (writable: string[], adapterWritable?: string[]) =>
        bwrapArgs({ home: opts.home, cwd, writable, hidden, adapterWritable, readable: configFile ? [configFile] : [] })

      let mcp = profile.mcp === false || !adapter.mcp ? {} : opts.mcpServers(cwd)
      // Sovereign's own endpoint searches the user's private notes (embeddings):
      // only a run whose model stays on the user's machines gets it.
      if (!(endpoint?.local && !adapter.remote)) {
        const { sovereign: _private, ...rest } = mcp
        mcp = rest
      }
      // Devin's (and Codex's) own sandbox covers the commands it runs, not the MCP servers it starts.
      if (sandbox === 'harness' && bwrap) {
        const wrapped: Record<string, McpServerSpec> = {}
        for (const [name, s] of Object.entries(mcp)) {
          wrapped[name] =
            s.type === 'stdio' ? { ...s, command: bwrap, args: [...sandboxArgs([]), s.command, ...s.args] } : s
        }
        mcp = wrapped
      }
      const env = filterEnv(opts.env ?? process.env)
      if (endpoint?.apiKey) env[ENDPOINT_KEY_ENV] = endpoint.apiKey
      Object.assign(env, profile.extraEnv ?? {})

      const briefFile = path.join(runDir, 'brief.md')
      const systemPrompt = buildSubagentSystemPrompt({ configDir: opts.configDir, cwd, home: opts.home })
      fs.writeFileSync(
        briefFile,
        buildHarnessBrief({ adapter: adapter.id, systemPrompt, task: o.task, mcp: Object.keys(mcp) }),
        { mode: 0o600 }
      )
      const exportFile = path.join(keepDir, 'export')
      let cmd: ReturnType<HarnessAdapter['prepare']>
      try {
        cmd = adapter.prepare({
          dir: runDir,
          keepDir,
          cwd,
          briefFile,
          exportFile,
          home: opts.home,
          bin,
          profile,
          model,
          endpoint,
          mcp,
          env
        })
      } catch (err) {
        cleanUp()
        throw err
      }
      let command = cmd.command
      let args = cmd.args
      if (sandbox === 'bwrap' && bwrap) {
        command = bwrap
        args = [...sandboxArgs([runDir, keepDir], adapter.writable), cmd.command, ...cmd.args]
      }

      // Its own process group, so a stop kills the CLI and every command it started.
      const stdin = cmd.stdinFile ? fs.openSync(cmd.stdinFile, 'r') : 'ignore'
      let child: ChildProcess
      try {
        child = spawnChild(command, args, { cwd, env: cmd.env, detached: true, stdio: [stdin, 'pipe', 'pipe'] })
      } finally {
        // The child holds its own copy.
        if (typeof stdin === 'number') fs.closeSync(stdin)
      }
      const run: Run = {
        sessionKey: key,
        parentKey,
        label,
        status: 'working',
        harness: o.harness,
        task: o.task,
        cwd,
        model,
        startedAt: Date.now(),
        adapter,
        child,
        runDir,
        keepDir,
        exportFile,
        stdout: '',
        stderr: ''
      }
      runs.set(key, run)
      if (child.pid) liveGroups.add(child.pid)
      installExitHook()
      persist()
      writeRecord(liveRecord(run))
      // A Claude Code subagent's start: the chat module maps the key on subagent.spawned.
      emitter.emit('session.info', { sessionKey: key, label, history: [] })
      emitter.emit('subagent.spawned', { parentKey, childKey: key, task: o.task, label })
      emitter.emit('chat.status', { sessionKey: key, status: 'working' })
      opts.activeSessions?.addSubagent(parentKey, { agentId: key, label, startedAt: run.startedAt })
      child.stdout!.setEncoding('utf8').on('data', (d: string) => {
        if (run.stdout.length >= MAX_STDOUT) return
        run.stdout += d
        const text = adapter.textStdout ? plainText(d) : ''
        if (text) emitter.emit('chat.stream', { sessionKey: key, text })
      })
      child.stderr!.setEncoding('utf8').on('data', (d: string) => {
        run.stderr = (run.stderr + d).slice(-STDERR_TAIL * 2)
      })
      child.on('error', (err) => {
        run.stderr += `\n${String(err)}`
        finish(run, null, null)
      })
      child.on('close', (code, signal) => finish(run, code, signal))
      const timeoutMs = profile.timeoutMinutes ? profile.timeoutMinutes * 60_000 : (o.timeoutMs ?? SUBAGENT_TIMEOUT_MS)
      run.timer = setTimeout(
        () => cutOff(run, `timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} min`, 'timed-out'),
        timeoutMs
      )
      return key
    },

    list(parentKey) {
      return [...runs.values()]
        .filter((r) => !parentKey || r.parentKey === parentKey)
        .map(({ sessionKey, parentKey: p, label, status, harness, task, cwd, model, startedAt }) => ({
          sessionKey,
          parentKey: p,
          label,
          status,
          harness,
          task,
          cwd,
          model,
          startedAt
        }))
    },

    has(key) {
      return runs.has(key)
    },

    async stop(key) {
      const run = runs.get(key)
      if (!run) throw new Error(`agents_stop: ${key} is not a running harness run`)
      cutOff(run, 'stopped by the parent', 'stopped')
    },

    describe() {
      return describeProfiles(opts.profiles(), opts.endpoints(), adapters)
    },

    recoverInterrupted() {
      const left = readPersisted().filter((p) => !runs.has(p.sessionKey))
      if (!left.length) return
      persist()
      const error = 'cut off by a Sovereign restart'
      for (const p of left) {
        const endedAt = Date.now()
        const durationMs = endedAt - p.startedAt
        const record = readRecord(p.sessionKey)
        if (record) writeRecord({ ...record, status: 'failed', endedAt, error })
        emitter.emit('subagent.failed', {
          parentKey: p.parentKey,
          childKey: p.sessionKey,
          label: p.label,
          durationMs,
          error,
          parentMessage: formatSubagentResult({ label: p.label, sessionKey: p.sessionKey, durationMs, error })
        })
        opts.activeSessions?.removeSubagent(p.parentKey, p.sessionKey)
      }
    },

    dispose() {
      for (const run of runs.values()) {
        run.disposed = true
        if (run.timer) clearTimeout(run.timer)
        if (run.child.pid) killGroup(run.child.pid, 'SIGKILL')
      }
    },

    records(parentKey) {
      let keys: string[] = []
      try {
        keys = fs.readdirSync(baseDir).filter((f) => f.startsWith('harness-'))
      } catch {
        /* no runs yet */
      }
      const out: HarnessRunRecord[] = []
      for (const key of new Set([...runs.keys(), ...keys])) {
        const record = recordOf(key)
        if (record && (!parentKey || record.parentKey === parentKey)) out.push(record)
      }
      return out.sort((a, b) => b.startedAt - a.startedAt)
    },

    record: recordOf,

    history(key) {
      const run = runs.get(key)
      const record = recordOf(key)
      if (!record) return null
      const keepDir = path.join(baseDir, key)
      let stdout = run?.stdout ?? ''
      if (!run) {
        try {
          stdout = fs.readFileSync(path.join(keepDir, 'output.log'), 'utf8')
        } catch {
          /* cut off by a restart: no output kept */
        }
      }
      const adapter = run?.adapter ?? adapters[record.adapter]
      const endedAt = record.endedAt ?? Date.now()
      let transcript: ParsedTurn[] = []
      try {
        transcript = adapter?.transcript?.(stdout, path.join(keepDir, 'export'), endedAt) ?? []
      } catch {
        /* an unreadable transcript: stdout stands in */
      }
      const turns = [turn('user', record.task, record.startedAt), ...transcript]
      if (record.status === 'working') {
        const last = transcript[transcript.length - 1]
        if (last) last.streaming = true
        else
          turns.push({
            ...turn('assistant', adapter?.textStdout ? plainText(stdout).trim() : '', endedAt),
            streaming: true
          })
        return turns
      }
      // The report closes the view, unless the transcript already ends on it.
      const last = transcript[transcript.length - 1]
      const endsOnText = !!last?.content.trim() && !last.workItems.length
      if (record.answer && !endsOnText) turns.push(turn('assistant', record.answer, endedAt))
      if (record.error) turns.push(failureTurn(record))
      return turns
    },

    on: emitter.on,
    off: emitter.off
  }
}
