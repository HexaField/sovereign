// Devin CLI executor for `agents_spawn` with `executor: 'devin'`.
//
// A run is one `devin -p` child process: the brief (the subagent system
// prompt, then the task) goes in through a prompt file, the final answer comes
// out on stdout, and `--export` writes the transcript into the data dir. The
// parent thread gets one [Subagent done: …] / [Subagent failed: …] message,
// as for a Claude Code subagent.
//
// Guard rails: the cwd must lie under `agentBackend.devin.allowedRoots` and
// never under ~/.sovereign or ~/workspaces/hexafield (private); the CLI runs
// with the locked-down `~/.config/devin/executor.json` (push, remotes, gh and
// ssh denied), `--sandbox`, and without the SSH agent or forge tokens.

import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatSubagentResult } from '@sovereign/core'
import {
  buildSubagentSystemPrompt,
  MAX_SUBAGENTS_PER_PARENT,
  SUBAGENT_TIMEOUT_MS
} from '../claude-code/subagent-runner.js'

export const DEVIN_DEFAULT_MODEL = 'swe-2-high'

/** Never a Devin cwd, whatever the allowlist says: Sovereign's own data and the private repos. */
export const DEVIN_DENIED_ROOTS = ['~/.sovereign', '~/workspaces/hexafield']

/** The only env vars a Devin run gets. Its sandbox has open network access, so
 *  nothing else from the server's env (tokens, the SSH agent socket) passes. */
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
 * The real path of a Devin run's cwd, or an error. The check runs on the real
 * path, so neither `..` nor a symlink leads out of an allowed root or into a
 * private one.
 */
export function resolveDevinCwd(
  cwd: string,
  opts: { home: string; allowedRoots: string[]; deniedRoots?: string[] }
): string {
  const resolved = path.resolve(expandHome(cwd, opts.home))
  let real: string
  try {
    real = fs.realpathSync(resolved)
  } catch {
    throw new Error(`agents_spawn: cwd ${resolved} is not a directory`)
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`agents_spawn: cwd ${resolved} is not a directory`)
  const denied = [...DEVIN_DENIED_ROOTS, ...(opts.deniedRoots ?? [])].map((r) =>
    realOrResolved(expandHome(r, opts.home))
  )
  if (denied.some((root) => isInside(real, root))) {
    throw new Error(`agents_spawn: devin may not run in ${real}: private directory`)
  }
  const allowed = opts.allowedRoots.filter(Boolean).map((r) => realOrResolved(expandHome(r, opts.home)))
  if (!allowed.some((root) => isInside(real, root))) {
    throw new Error(
      `agents_spawn: devin may not run in ${real}: not under agentBackend.devin.allowedRoots (${opts.allowedRoots.join(', ') || 'none'})`
    )
  }
  return real
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

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const SANDBOX_WARNING_RE = /^Warning: --sandbox always uses /

/**
 * The answer in `devin -p` stdout: without the login banner ("Logged in as …"
 * up to the first blank line), the sandbox warning, ANSI codes and CRs.
 */
export function stripDevinBanner(stdout: string): string {
  const lines = stdout.replace(ANSI_RE, '').replace(/\r/g, '').split('\n')
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

/** `devin` on PATH, else in ~/.local/bin (the installer's place, often off a service's PATH); null when absent. */
export function findDevinBinary(pathEnv: string | undefined, home: string): string | null {
  const dirs = [...(pathEnv ?? '').split(path.delimiter).filter(Boolean), path.join(home, '.local', 'bin')]
  for (const dir of dirs) {
    const file = path.join(dir, 'devin')
    try {
      fs.accessSync(file, fs.constants.X_OK)
      if (fs.statSync(file).isFile()) return file
    } catch {
      /* not here */
    }
  }
  return null
}

/** The `devin -p` command line for one run. */
export function buildDevinCommand(opts: {
  bin: string
  configFile: string
  briefFile: string
  model: string
  exportFile: string
  env: NodeJS.ProcessEnv
}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(opts.env))
    if (PASSED_ENV.includes(key) || PASSED_ENV_PREFIXES.some((p) => key.startsWith(p))) env[key] = value
  return {
    command: opts.bin,
    args: [
      '--config',
      opts.configFile,
      '-p',
      '--prompt-file',
      opts.briefFile,
      '--model',
      opts.model,
      '--sandbox',
      '--export',
      opts.exportFile
    ],
    env
  }
}

/** The brief: what a Devin run needs beyond the subagent prompt, then that prompt, then the task. */
function buildBrief(systemPrompt: string, task: string): string {
  return [
    '# Running as a Sovereign subagent through the Devin CLI',
    '',
    'The rules below come from the brief every Sovereign subagent gets. The tools it names ' +
      '(codegraph, semble, mcp__code__edit, browser, Sovereign MCP tools) are not available ' +
      'to you: use your own tools. Hard rules:',
    '- You never commit, push, add remotes, create or switch branches. Leave changes in the working tree.',
    '- No destructive actions outside the working directory.',
    '- Your final message is the report: what you changed (paths), commands run with results, what is left open.',
    '',
    systemPrompt,
    '',
    '# Task',
    '',
    task
  ].join('\n')
}

export interface DevinSpawnOptions {
  task: string
  cwd?: string
  label?: string
  /** Devin model id; default `agentBackend.devin.defaultModel`. */
  model?: string
  timeoutMs?: number
}

export interface DevinRunSummary {
  sessionKey: string
  parentKey: string
  label: string
  status: 'working'
  task: string
  cwd: string
  model: string
  startedAt: number
}

export interface DevinExecutor {
  /** Start a run; returns its key at once. The parent gets one message when it ends. */
  spawn(parentKey: string, opts: DevinSpawnOptions): Promise<string>
  /** Running runs (finished ones drop out). */
  list(parentKey?: string): DevinRunSummary[]
  has(key: string): boolean
  /** End a run: kills its process group; the parent gets a failure message. */
  stop(key: string): Promise<void>
  /** Tell parents about runs a restart cut off (left in runs.json). Call once the parent delivery is wired. */
  recoverInterrupted(): void
  /** Kill every run without telling parents: shutdown. The next boot's recoverInterrupted tells them. */
  dispose(): void
}

export interface DevinExecutorOptions {
  dataDir: string
  home: string
  /** Sovereign config dir: SUBAGENT.md, and refused as a cwd. */
  configDir?: string
  /** Read at every spawn, so a config change applies to the next run. */
  settings: () => { defaultModel?: string; allowedRoots?: string[] }
  /** Deliver the result message into the parent thread. */
  deliver: (parentKey: string, text: string) => void
  /** Where to look for `devin`; default the process PATH. */
  pathEnv?: string
  /** The child's environment before stripping; default the process env. */
  env?: NodeJS.ProcessEnv
}

interface Run extends DevinRunSummary {
  child: ChildProcess
  briefDir: string
  exportFile: string
  stdout: string
  stderr: string
  /** Set when the run was cut off rather than ending on its own. */
  ended?: string
  disposed?: boolean
  timer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
}

/** Every live Devin process group, killed when Sovereign's process exits. */
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

export function createDevinExecutor(opts: DevinExecutorOptions): DevinExecutor {
  const dir = path.join(opts.dataDir, 'agent-backend', 'devin')
  const runsFile = path.join(dir, 'runs.json')
  const configFile = path.join(opts.home, '.config', 'devin', 'executor.json')
  const trustFile = path.join(opts.home, '.local', 'share', 'devin', 'cli', 'trusted_workspaces.json')
  const runs = new Map<string, Run>()

  type Persisted = Pick<DevinRunSummary, 'sessionKey' | 'parentKey' | 'label' | 'startedAt'>
  function readPersisted(): Persisted[] {
    try {
      return JSON.parse(fs.readFileSync(runsFile, 'utf8'))
    } catch {
      return []
    }
  }
  function writePersisted(list: Persisted[]): void {
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${runsFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
    fs.renameSync(tmp, runsFile)
  }
  function persist(): void {
    writePersisted(
      [...runs.values()].map(({ sessionKey, parentKey, label, startedAt }) => ({
        sessionKey,
        parentKey,
        label,
        startedAt
      }))
    )
  }

  function finish(run: Run, code: number | null, signal: NodeJS.Signals | null): void {
    if (!runs.has(run.sessionKey)) return
    runs.delete(run.sessionKey)
    if (run.timer) clearTimeout(run.timer)
    if (run.killTimer) clearTimeout(run.killTimer)
    if (run.child.pid) liveGroups.delete(run.child.pid)
    fs.rmSync(run.briefDir, { recursive: true, force: true })
    if (run.disposed) return
    persist()
    const answer = stripDevinBanner(run.stdout)
    const stderrTail = run.stderr.trim().slice(-STDERR_TAIL)
    let error: string | undefined
    let body = answer
    if (run.ended) error = run.ended
    else if (code !== 0) {
      error = signal ? `devin ended on ${signal}` : `devin exited with code ${code}`
      if (stderrTail) body = [answer, `stderr (tail):\n\n\`\`\`\n${stderrTail}\n\`\`\``].filter(Boolean).join('\n\n')
    } else if (!answer) error = 'ended without a result'
    if (fs.existsSync(run.exportFile)) body = [body, `Transcript: ${run.exportFile}`].filter(Boolean).join('\n\n')
    opts.deliver(
      run.parentKey,
      formatSubagentResult({
        label: run.label,
        sessionKey: run.sessionKey,
        durationMs: Date.now() - run.startedAt,
        result: body,
        error
      })
    )
  }

  /** Cut a run off: SIGTERM to its process group, SIGKILL after a grace period. */
  function cutOff(run: Run, reason: string): void {
    if (run.ended) return
    run.ended = reason
    const pid = run.child.pid
    if (!pid) return
    killGroup(pid, 'SIGTERM')
    run.killTimer = setTimeout(() => killGroup(pid, 'SIGKILL'), KILL_GRACE_MS)
    run.killTimer.unref?.()
  }

  return {
    async spawn(parentKey, o) {
      const running = [...runs.values()].filter((r) => r.parentKey === parentKey).length
      if (running >= MAX_SUBAGENTS_PER_PARENT) {
        throw new Error(
          `agents_spawn: ${running} devin runs already run for this thread (max ${MAX_SUBAGENTS_PER_PARENT}); wait for one to finish`
        )
      }
      if (!o.cwd) throw new Error('agents_spawn: executor devin needs a cwd under agentBackend.devin.allowedRoots')
      const settings = opts.settings()
      const cwd = resolveDevinCwd(o.cwd, {
        home: opts.home,
        allowedRoots: settings.allowedRoots ?? [],
        deniedRoots: [opts.dataDir, ...(opts.configDir ? [opts.configDir] : [])]
      })
      const bin = findDevinBinary(opts.pathEnv ?? process.env.PATH, opts.home)
      if (!bin) throw new Error('agents_spawn: the devin CLI was not found (PATH, ~/.local/bin)')
      if (!fs.existsSync(configFile)) throw new Error(`agents_spawn: devin executor config ${configFile} is missing`)
      trustWorkspace(trustFile, cwd)

      const key = `devin-${randomUUID()}`
      const model = o.model || settings.defaultModel || DEVIN_DEFAULT_MODEL
      const label = o.label ?? o.task.slice(0, 60)
      fs.mkdirSync(dir, { recursive: true })
      // `--export` writes the transcript as ATIF JSON, whatever the file name.
      const exportFile = path.join(dir, `${key}.json`)
      const briefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-devin-'))
      const briefFile = path.join(briefDir, 'brief.md')
      const systemPrompt = buildSubagentSystemPrompt({ configDir: opts.configDir, cwd, home: opts.home })
      fs.writeFileSync(briefFile, buildBrief(systemPrompt, o.task), { mode: 0o600 })

      const cmd = buildDevinCommand({ bin, configFile, briefFile, model, exportFile, env: opts.env ?? process.env })
      // Its own process group, so a stop kills the CLI and every command it started.
      const child = spawnChild(cmd.command, cmd.args, {
        cwd,
        env: cmd.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const run: Run = {
        sessionKey: key,
        parentKey,
        label,
        status: 'working',
        task: o.task,
        cwd,
        model,
        startedAt: Date.now(),
        child,
        briefDir,
        exportFile,
        stdout: '',
        stderr: ''
      }
      runs.set(key, run)
      if (child.pid) liveGroups.add(child.pid)
      installExitHook()
      persist()
      child.stdout!.setEncoding('utf8').on('data', (d: string) => {
        if (run.stdout.length < MAX_STDOUT) run.stdout += d
      })
      child.stderr!.setEncoding('utf8').on('data', (d: string) => {
        run.stderr = (run.stderr + d).slice(-STDERR_TAIL * 2)
      })
      child.on('error', (err) => {
        run.stderr += `\n${String(err)}`
        finish(run, null, null)
      })
      child.on('close', (code, signal) => finish(run, code, signal))
      const timeoutMs = o.timeoutMs ?? SUBAGENT_TIMEOUT_MS
      run.timer = setTimeout(
        () => cutOff(run, `timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} min`),
        timeoutMs
      )
      return key
    },

    list(parentKey) {
      return [...runs.values()]
        .filter((r) => !parentKey || r.parentKey === parentKey)
        .map(({ sessionKey, parentKey: p, label, status, task, cwd, model, startedAt }) => ({
          sessionKey,
          parentKey: p,
          label,
          status,
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
      if (!run) throw new Error(`agents_stop: ${key} is not a running devin run`)
      cutOff(run, 'stopped by the parent')
    },

    recoverInterrupted() {
      const left = readPersisted().filter((p) => !runs.has(p.sessionKey))
      if (!left.length) return
      persist()
      for (const p of left) {
        opts.deliver(
          p.parentKey,
          formatSubagentResult({
            label: p.label,
            sessionKey: p.sessionKey,
            durationMs: Date.now() - p.startedAt,
            error: 'cut off by a Sovereign restart'
          })
        )
      }
    },

    dispose() {
      for (const run of runs.values()) {
        run.disposed = true
        if (run.timer) clearTimeout(run.timer)
        if (run.child.pid) killGroup(run.child.pid, 'SIGKILL')
      }
    }
  }
}
