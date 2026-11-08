import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HarnessProfile, ModelEndpoint } from '@sovereign/config'
import { ENDPOINT_KEY_ENV, type HarnessAdapter } from './adapter.js'
import { devinAdapter } from './adapters/devin.js'
import {
  buildHarnessBrief,
  bwrapArgs,
  createHarnessRunner,
  describeProfiles,
  filterEnv,
  findBinary,
  resolveHarnessCwd,
  type HarnessRunner,
  type HarnessRunnerOptions
} from './runner.js'

let tmp: string
let home: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runner-test-')))
  home = path.join(tmp, 'home')
  fs.mkdirSync(path.join(home, 'workspaces', 'coasys', 'ad4m'), { recursive: true })
  fs.mkdirSync(path.join(home, 'workspaces', 'hexafield', 'sovereign'), { recursive: true })
  fs.mkdirSync(path.join(home, '.sovereign', 'data'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveHarnessCwd', () => {
  const roots = ['~/workspaces/coasys']
  const guard = (cwd: string, extra: Partial<Parameters<typeof resolveHarnessCwd>[1]> = {}) =>
    resolveHarnessCwd(cwd, { home, allowedRoots: roots, name: 'devin', ...extra })

  it('allows a directory under an allowed root and returns its real path', () => {
    expect(guard('~/workspaces/coasys/ad4m')).toBe(path.join(home, 'workspaces', 'coasys', 'ad4m'))
    const link = path.join(tmp, 'shortcut')
    fs.symlinkSync(path.join(home, 'workspaces', 'coasys', 'ad4m'), link)
    expect(guard(link)).toBe(path.join(home, 'workspaces', 'coasys', 'ad4m'))
  })

  it('refuses a directory outside every allowed root, naming the profile', () => {
    expect(() => guard(path.join(home, 'workspaces'))).toThrow(/agentBackend\.harnesses\.devin\.allowedRoots/)
    fs.mkdirSync(path.join(home, 'workspaces', 'coasys-private'))
    expect(() => guard('~/workspaces/coasys-private')).toThrow(/allowedRoots/)
    expect(() => guard('~/workspaces/coasys/ad4m/../..')).toThrow(/allowedRoots/)
  })

  it('refuses private directories through `..`, symlinks and a wide allowlist', () => {
    expect(() => guard('~/workspaces/coasys/../hexafield/sovereign')).toThrow(/private/)
    const link = path.join(home, 'workspaces', 'coasys', 'sneaky')
    fs.symlinkSync(path.join(home, 'workspaces', 'hexafield', 'sovereign'), link)
    expect(() => guard(link)).toThrow(/private/)
    expect(() => guard('~/.sovereign/data', { allowedRoots: ['~'] })).toThrow(/private/)
    expect(() => guard('~/workspaces/coasys/ad4m', { deniedRoots: [path.join(home, 'workspaces', 'coasys')] })).toThrow(
      /private/
    )
  })

  it('allows a private directory when the run stays local', () => {
    const wide = { allowedRoots: ['~/workspaces'], privateOk: true }
    expect(guard('~/workspaces/hexafield/sovereign', wide)).toBe(
      path.join(home, 'workspaces', 'hexafield', 'sovereign')
    )
    // Still only under the profile's own roots.
    expect(() => guard('~/.sovereign/data', wide)).toThrow(/allowedRoots/)
  })

  it('refuses a cwd that does not exist or is not a directory', () => {
    expect(() => guard('~/workspaces/coasys/missing')).toThrow(/not a directory/)
    fs.writeFileSync(path.join(home, 'workspaces', 'coasys', 'file.txt'), 'x')
    expect(() => guard('~/workspaces/coasys/file.txt')).toThrow(/not a directory/)
  })
})

describe('filterEnv', () => {
  it('keeps only the allowlist and XDG_*: a secret added to the server env later never reaches a harness', () => {
    expect(
      filterEnv({
        PATH: '/usr/bin',
        HOME: '/h',
        LANG: 'en_AU.UTF-8',
        XDG_RUNTIME_DIR: '/run/user/1',
        SSH_AUTH_SOCK: '/run/ssh.sock',
        GH_TOKEN: 'gh',
        ANTHROPIC_API_KEY: 'k',
        SOME_NEW_API_KEY: 'leak'
      })
    ).toEqual({ PATH: '/usr/bin', HOME: '/h', LANG: 'en_AU.UTF-8', XDG_RUNTIME_DIR: '/run/user/1' })
  })
})

describe('findBinary', () => {
  it('finds a CLI on PATH, then in ~/.local/bin, skipping one that is not executable', () => {
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    expect(findBinary('pi', bin, home)).toBeNull()
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, '.local', 'bin', 'pi'), '#!/bin/sh\n', { mode: 0o755 })
    expect(findBinary('pi', bin, home)).toBe(path.join(home, '.local', 'bin', 'pi'))
    fs.writeFileSync(path.join(bin, 'pi'), 'x', { mode: 0o644 })
    expect(findBinary('pi', bin, home)).toBe(path.join(home, '.local', 'bin', 'pi'))
    fs.chmodSync(path.join(bin, 'pi'), 0o755)
    expect(findBinary('pi', bin, home)).toBe(path.join(bin, 'pi'))
  })
})

describe('bwrapArgs', () => {
  it('binds / read-only, hides credentials and private dirs, and makes cwd, run dirs and caches writable', () => {
    for (const p of ['.ssh', '.gnupg', '.config/gh', '.claude', '.cache', '.local/share/devin']) {
      fs.mkdirSync(path.join(home, p), { recursive: true })
    }
    fs.writeFileSync(path.join(home, '.claude.json'), '{}')
    fs.mkdirSync(path.join(home, 'sovereign-backup-2026'))
    const cwd = path.join(home, 'workspaces', 'coasys', 'ad4m')
    const runDir = path.join(tmp, 'run')
    const keep = path.join(tmp, 'keep')
    fs.mkdirSync(runDir)
    fs.mkdirSync(keep)
    const configFile = path.join(tmp, 'devin.json')
    fs.writeFileSync(configFile, '{}')
    const args = bwrapArgs({
      home,
      cwd,
      writable: [runDir, keep],
      hidden: [path.join(home, '.sovereign'), path.join(home, 'workspaces', 'hexafield'), path.join(tmp, 'absent')],
      adapterWritable: ['.local/share/devin'],
      readable: [configFile]
    })
    expect(args.slice(0, 8)).toEqual([
      '--die-with-parent',
      '--ro-bind',
      '/',
      '/',
      '--dev-bind',
      '/dev',
      '/dev',
      '--bind'
    ])
    const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))
    expect(pairs('--tmpfs').sort()).toEqual(
      ['.ssh', '.gnupg', '.config/gh', '.claude', 'sovereign-backup-2026', '.sovereign', 'workspaces/hexafield']
        .map((p) => path.join(home, p))
        .sort()
    )
    // A credential file is masked by /dev/null.
    expect(args.join(' ')).toContain(`--ro-bind /dev/null ${path.join(home, '.claude.json')}`)
    // A path that does not exist is not mounted over; the adapter's own state stays visible and writable.
    expect(args).not.toContain(path.join(tmp, 'absent'))
    expect(pairs('--bind')).toEqual([
      '/tmp',
      path.join(home, '.cache'),
      path.join(home, '.local/share/devin'),
      cwd,
      runDir,
      keep
    ])
    expect(args.join(' ')).toContain(`--ro-bind ${configFile} ${configFile}`)
    expect(args.slice(-2)).toEqual(['--chdir', cwd])
    expect(args).not.toContain('--unshare-net')
  })
})

describe('buildHarnessBrief', () => {
  it('puts the hard rules and the MCP line before the subagent prompt and the task', () => {
    const brief = buildHarnessBrief({
      adapter: 'opencode',
      systemPrompt: 'RULES',
      task: 'Fix it.',
      mcp: ['code', 'semble']
    })
    expect(brief).toMatch(/^# Running as a Sovereign subagent through opencode\n/)
    expect(brief).toContain('- You never commit, push, add remotes, create or switch branches.')
    expect(brief).toContain('MCP servers: code, semble (tools named mcp__<server>__<tool>')
    expect(brief.indexOf('RULES')).toBeLessThan(brief.indexOf('# Task\n\nFix it.'))
    expect(buildHarnessBrief({ adapter: 'pi', systemPrompt: '', task: 't', mcp: [] })).toContain(
      'No MCP servers are available to you'
    )
  })
})

describe('describeProfiles', () => {
  it('gives one line per profile: adapter, model, endpoint and where it runs, MCP', () => {
    const lines = describeProfiles(
      {
        claude: { adapter: 'claude' },
        devin: { adapter: 'devin', model: 'swe-2-high', mcp: true },
        studio: { adapter: 'pi', model: 'qwen3', endpoint: 'studio' },
        broken: { adapter: 'opencode', model: 'x', endpoint: 'missing' }
      },
      { studio: { api: 'openai', baseUrl: 'http://s/v1', local: true } }
    )
    expect(lines).toEqual([
      'claude: Claude Code (default subagent), cloud, MCP yes',
      'devin: devin, model swe-2-high, Devin login (cloud), MCP yes',
      'studio: pi, model qwen3, endpoint studio (local), MCP no',
      'broken: opencode, model x, endpoint missing (not configured), MCP yes'
    ])
  })
})

// ── The runner, against a fake harness ───────────────────────────────────────

/** A fake CLI: `fake <brief> <export>`. "FAIL" in the brief exits 1, "HANG" sleeps. */
const FAKE_CLI = `#!/bin/sh
brief="$1"; export_file="$2"
pwd > "$PWD/.fake-cwd"
env > "$PWD/.fake-env"
echo "# transcript" > "$export_file"
if [ -e "$HOME/.ssh/id_test" ]; then echo "saw ssh key"; fi
if grep -q HANG "$brief"; then sleep 30; fi
if grep -q FAIL "$brief"; then echo "boom: model refused" >&2; exit 1; fi
if grep -q SILENT "$brief"; then echo "context window exceeded" >&2; exit 0; fi
echo "Fixed it."
echo "Brief had: $(grep -c 'never commit' "$brief") never-commit line(s)"
`

const fakeAdapter: HarnessAdapter = {
  id: 'pi',
  bin: 'fake-harness',
  remote: false,
  mcp: true,
  ownSandbox: false,
  prepare(run) {
    fs.writeFileSync(path.join(run.dir, 'config.json'), JSON.stringify({ mcp: run.mcp, model: run.model }))
    return { command: run.bin, args: [run.briefFile, run.exportFile], env: run.env }
  },
  report(stdout) {
    return stdout.trim()
  },
  textStdout: true
}

const EVENT_NAMES = [
  'session.info',
  'subagent.spawned',
  'chat.status',
  'chat.stream',
  'chat.turn',
  'subagent.completed',
  'subagent.failed'
] as const

describe('createHarnessRunner', () => {
  let bin: string
  let work: string
  let dataDir: string
  let delivered: Array<[string, string]>
  let events: Array<{ name: string; data: any }>
  let runner: HarnessRunner | undefined
  let profiles: Record<string, HarnessProfile>
  let endpoints: Record<string, ModelEndpoint>
  let lastRunDirs: string[]

  beforeEach(() => {
    bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'fake-harness'), FAKE_CLI, { mode: 0o755 })
    work = path.join(home, 'workspaces', 'coasys', 'ad4m')
    dataDir = path.join(tmp, 'data')
    delivered = []
    events = []
    lastRunDirs = []
    profiles = {
      claude: { adapter: 'claude' },
      fake: { adapter: 'pi', model: 'm1', endpoint: 'studio', sandbox: 'none', allowedRoots: ['~/workspaces/coasys'] },
      cloud: { adapter: 'pi', model: 'm2', endpoint: 'cloud', sandbox: 'none', allowedRoots: ['~/workspaces'] },
      local: { adapter: 'pi', model: 'm3', endpoint: 'studio', sandbox: 'none', allowedRoots: ['~/workspaces'] }
    }
    endpoints = {
      studio: { api: 'openai', baseUrl: 'http://studio.example/v1', local: true },
      cloud: { api: 'openai', baseUrl: 'https://llm.example/v1', apiKeySecret: 'cloudKey', local: false }
    }
  })

  afterEach(() => {
    runner?.dispose()
    runner = undefined
  })

  function make(overrides: Partial<HarnessRunnerOptions> = {}): HarnessRunner {
    runner = createHarnessRunner({
      dataDir,
      home,
      configDir: path.join(home, '.sovereign'),
      profiles: () => profiles,
      endpoints: () => endpoints,
      secret: (name) => (name === 'cloudKey' ? 'sk-cloud' : undefined),
      mcpServers: (cwd) => ({ code: { type: 'stdio', command: 'node', args: ['--edit-roots', cwd], env: {} } }),
      pathEnv: bin,
      env: { PATH: '/usr/bin:/bin', HOME: home, SSH_AUTH_SOCK: '/run/ssh.sock', GH_TOKEN: 'gh' },
      adapters: {
        pi: {
          ...fakeAdapter,
          prepare(run) {
            lastRunDirs.push(run.dir)
            return fakeAdapter.prepare(run)
          }
        }
      },
      ...overrides
    })
    // The parent's message rides on the run's last event: wiring delivers it, once.
    for (const name of EVENT_NAMES) {
      runner.on(name, (data: any) => {
        events.push({ name, data })
        if (data.parentMessage) delivered.push([data.parentKey, data.parentMessage])
      })
    }
    return runner
  }

  async function until(cond: () => boolean, ms = 10_000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('runs a task, lists it while it works, then stops it on request', async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'Fix the bug. HANG', cwd: work, label: 'fix bug' })
    expect(key).toMatch(/^harness-/)
    expect(r.list()).toEqual([
      expect.objectContaining({ sessionKey: key, label: 'fix bug', status: 'working', harness: 'fake', model: 'm1' })
    ])
    expect(r.list('other-parent')).toHaveLength(0)
    expect(r.has(key)).toBe(true)
    await r.stop(key)
    await until(() => delivered.length === 1)
    expect(delivered[0][0]).toBe('parent-1')
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: fix bug\] after 1 min — stopped by the parent/)
    expect(r.list()).toEqual([])
    expect(r.has(key)).toBe(false)
  })

  it('delivers the report on exit 0 with the kept transcript dir, and deletes the run dir', async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'Fix the bug.', cwd: work, label: 'fix bug' })
    await until(() => delivered.length === 1)
    const text = delivered[0][1]
    expect(text).toMatch(/^\[Subagent done: fix bug\] after 1 min\n\nFixed it\.\n/)
    expect(text).toMatch(/Brief had: [1-9]\d* never-commit line\(s\)/)
    const keep = path.join(dataDir, 'agent-backend', 'harness', key)
    expect(text).toContain(`Transcript: ${keep}`)
    expect(text).toMatch(new RegExp(`Session: ${key}$`))
    expect(fs.readFileSync(path.join(keep, 'output.log'), 'utf8')).toContain('Fixed it.')
    expect(fs.readdirSync(keep).sort()).toEqual(['export', 'output.log', 'run.json'])
    expect(fs.existsSync(lastRunDirs[0])).toBe(false)
    // It ran in the real cwd with the filtered env: no SSH agent, no forge token.
    expect(fs.readFileSync(path.join(work, '.fake-cwd'), 'utf8').trim()).toBe(work)
    const env = fs.readFileSync(path.join(work, '.fake-env'), 'utf8')
    expect(env).not.toMatch(/SSH_AUTH_SOCK|GH_TOKEN/)
    expect(env).not.toContain(ENDPOINT_KEY_ENV)
  })

  it('passes the endpoint key from the secret store only in the env, plus extraEnv', async () => {
    profiles.cloud.extraEnv = { EXTRA: 'yes' }
    const r = make()
    await r.spawn('p', { harness: 'cloud', task: 't', cwd: work })
    await until(() => delivered.length === 1)
    const env = fs.readFileSync(path.join(work, '.fake-env'), 'utf8')
    expect(env).toContain(`${ENDPOINT_KEY_ENV}=sk-cloud`)
    expect(env).toContain('EXTRA=yes')
    expect(delivered[0][1]).not.toContain('sk-cloud')
  })

  it('delivers [Subagent failed] with the exit code and the stderr tail on a non-zero exit', async () => {
    const r = make()
    await r.spawn('parent-1', { harness: 'fake', task: 'FAIL please', cwd: work, label: 'doomed' })
    await until(() => delivered.length === 1)
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: doomed\] after 1 min — pi exited with code 1/)
    expect(delivered[0][1]).toContain('boom: model refused')
  })

  it('a run that exits 0 with no answer fails with the stderr tail, kept as stderr.log', async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'SILENT', cwd: work, label: 'mute' })
    await until(() => delivered.length === 1)
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: mute\] after 1 min — ended without a result/)
    expect(delivered[0][1]).toContain('context window exceeded')
    const keep = path.join(dataDir, 'agent-backend', 'harness', key)
    expect(fs.readFileSync(path.join(keep, 'stderr.log'), 'utf8')).toContain('context window exceeded')
  })

  it('stops a run at its time limit: the profile first, then the spawn default', async () => {
    const r = make()
    await r.spawn('p', { harness: 'fake', task: 'HANG', cwd: work, label: 'slow', timeoutMs: 200 })
    await until(() => delivered.length === 1)
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: slow\] after 1 min — timed out after 1 min/)
    profiles.fake.timeoutMinutes = 0.005
    await r.spawn('p', { harness: 'fake', task: 'HANG', cwd: work, label: 'slow2', timeoutMs: 60_000 })
    await until(() => delivered.length === 2)
    expect(delivered[1][1]).toMatch(/timed out/)
  })

  it('keeps a private repo away from cloud endpoints and allows it on a local one', async () => {
    const r = make()
    const priv = path.join(home, 'workspaces', 'hexafield', 'sovereign')
    await expect(r.spawn('p', { harness: 'cloud', task: 't', cwd: priv })).rejects.toThrow(/private/)
    await r.spawn('p', { harness: 'local', task: 't', cwd: priv })
    await until(() => delivered.length === 1)
    expect(delivered[0][1]).toMatch(/^\[Subagent done/)
    // A remote harness (Devin) never gets one, even on a local endpoint.
    const r2 = make({ adapters: { pi: { ...fakeAdapter, remote: true } } })
    await expect(r2.spawn('p', { harness: 'local', task: 't', cwd: priv })).rejects.toThrow(/private/)
  })

  it('refuses bad requests before starting anything', async () => {
    const r = make()
    await expect(r.spawn('p', { harness: 'nope', task: 't', cwd: work })).rejects.toThrow(/unknown harness nope.*fake/)
    await expect(r.spawn('p', { harness: 'claude', task: 't', cwd: work })).rejects.toThrow(/claude/)
    await expect(r.spawn('p', { harness: 'fake', task: 't' })).rejects.toThrow(/cwd/)
    profiles.fake.endpoint = 'missing'
    await expect(r.spawn('p', { harness: 'fake', task: 't', cwd: work })).rejects.toThrow(/endpoint missing/)
    profiles.fake.endpoint = 'studio'
    endpoints.cloud.apiKeySecret = 'absent'
    await expect(r.spawn('p', { harness: 'cloud', task: 't', cwd: work })).rejects.toThrow(/secret absent/)
    profiles.fake.sandbox = 'harness'
    await expect(r.spawn('p', { harness: 'fake', task: 't', cwd: work })).rejects.toThrow(/sandbox/)
    profiles.fake.sandbox = 'none'
    const noBin = make({ pathEnv: path.join(tmp, 'empty') })
    await expect(noBin.spawn('p', { harness: 'fake', task: 't', cwd: work })).rejects.toThrow(/fake-harness.*not found/)
    expect(delivered).toEqual([])
  })

  it('gives the adapter the MCP set for the cwd, or none when the profile turns MCP off', async () => {
    const seen: any[] = []
    const r = make({
      adapters: {
        pi: {
          ...fakeAdapter,
          prepare(run) {
            seen.push({ mcp: run.mcp, model: run.model })
            return fakeAdapter.prepare(run)
          }
        }
      }
    })
    await r.spawn('p', { harness: 'fake', task: 't', cwd: work, model: 'override' })
    profiles.fake.mcp = false
    await r.spawn('p', { harness: 'fake', task: 't', cwd: work })
    expect(seen[0]).toEqual({
      mcp: { code: { type: 'stdio', command: 'node', args: ['--edit-roots', work], env: {} } },
      model: 'override'
    })
    expect(seen[1]).toEqual({ mcp: {}, model: 'm1' })
    await until(() => delivered.length === 2)
  })

  it("keeps Sovereign's own MCP endpoint (embeddings over private notes) from any run whose model is not local", async () => {
    const seen: Array<string[]> = []
    const r = make({
      mcpServers: () => ({
        codegraph: { type: 'stdio', command: 'codegraph', args: [], env: {} },
        sovereign: { type: 'http', url: 'http://localhost:5801/api/mcp/subagent' }
      }),
      adapters: {
        pi: {
          ...fakeAdapter,
          prepare(run) {
            seen.push(Object.keys(run.mcp).sort())
            return fakeAdapter.prepare(run)
          }
        },
        devin: {
          ...fakeAdapter,
          id: 'devin',
          remote: true,
          prepare: (run) => (seen.push(Object.keys(run.mcp).sort()), fakeAdapter.prepare(run))
        }
      }
    })
    profiles.devinLike = { adapter: 'devin', model: 'swe', sandbox: 'none', allowedRoots: ['~/workspaces/coasys'] }
    await r.spawn('p', { harness: 'local', task: 't', cwd: work })
    await r.spawn('p', { harness: 'cloud', task: 't', cwd: work })
    await r.spawn('p', { harness: 'devinLike', task: 't', cwd: work })
    expect(seen).toEqual([['codegraph', 'sovereign'], ['codegraph'], ['codegraph']])
    await until(() => delivered.length === 3)
  })

  it('caps running runs per parent', async () => {
    const r = make()
    for (let i = 0; i < 4; i++) await r.spawn('p', { harness: 'fake', task: 'HANG', cwd: work })
    await expect(r.spawn('p', { harness: 'fake', task: 'HANG', cwd: work })).rejects.toThrow(/max 4/)
    await r.spawn('other', { harness: 'fake', task: 'HANG', cwd: work })
    expect(r.list()).toHaveLength(5)
  })

  it('tells the parent about a run a restart cut off, once', async () => {
    const first = make()
    const key = await first.spawn('parent-1', { harness: 'fake', task: 'HANG', cwd: work, label: 'long job' })
    first.dispose()
    expect(delivered).toEqual([])
    const second = make()
    second.recoverInterrupted()
    expect(delivered).toHaveLength(1)
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: long job\] after \d+ min — cut off by a Sovereign restart/)
    expect(delivered[0][1]).toContain(`Session: ${key}`)
    make().recoverInterrupted()
    expect(delivered).toHaveLength(1)
  })

  it("emits a Claude subagent's events in order, with the parent's message on the last one only", async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'Fix the bug.', cwd: work, label: 'fix bug' })
    await until(() => events.some((e) => e.name === 'subagent.completed'))
    const names = events.map((e) => e.name).filter((n) => n !== 'chat.stream')
    expect(names).toEqual([
      'session.info',
      'subagent.spawned',
      'chat.status',
      'chat.turn',
      'chat.status',
      'subagent.completed'
    ])
    const of = (name: string) => events.filter((e) => e.name === name).map((e) => e.data)
    expect(of('session.info')[0]).toEqual({ sessionKey: key, label: 'fix bug', history: [], backendKind: 'harness' })
    expect(of('subagent.spawned')[0]).toEqual({
      parentKey: 'parent-1',
      childKey: key,
      task: 'Fix the bug.',
      label: 'fix bug',
      backendKind: 'harness'
    })
    expect(of('chat.status').map((d) => d.status)).toEqual(['working', 'idle'])
    // stdout streams into the view as the model writes it (a text-stdout adapter).
    expect(
      of('chat.stream')
        .map((d) => d.text)
        .join('')
    ).toContain('Fixed it.')
    expect(of('chat.turn')[0].turn).toMatchObject({ role: 'assistant', content: expect.stringMatching(/^Fixed it\./) })
    const done = of('subagent.completed')[0]
    expect(done).toMatchObject({ parentKey: 'parent-1', childKey: key, label: 'fix bug', result: expect.any(String) })
    expect(done.durationMs).toBeGreaterThanOrEqual(0)
    expect(done.parentMessage).toMatch(/^\[Subagent done: fix bug\] after 1 min\n\nFixed it\./)
    expect(delivered).toHaveLength(1)
  })

  it('emits subagent.failed with the error, how it ended, and the parent message', async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'HANG', cwd: work, label: 'long' })
    await r.stop(key)
    await until(() => events.some((e) => e.name === 'subagent.failed'))
    const failed = events.find((e) => e.name === 'subagent.failed')!.data
    expect(failed).toMatchObject({
      parentKey: 'parent-1',
      childKey: key,
      label: 'long',
      error: 'stopped by the parent',
      ended: 'stopped',
      parentMessage: expect.stringMatching(/^\[Subagent failed: long\]/)
    })
    expect(events.filter((e) => e.name === 'subagent.completed')).toEqual([])
    expect(delivered).toHaveLength(1)
  })

  it('tracks each run under its parent in activeSessions while it runs', async () => {
    const calls: string[] = []
    const r = make({
      activeSessions: {
        addSubagent: (parent, sub) => calls.push(`add ${parent} ${sub.agentId} ${sub.label}`),
        removeSubagent: (parent, id) => calls.push(`remove ${parent} ${id}`)
      }
    })
    const key = await r.spawn('parent-1', { harness: 'fake', task: 't', cwd: work, label: 'l' })
    expect(calls).toEqual([`add parent-1 ${key} l`])
    await until(() => delivered.length === 1)
    expect(calls).toEqual([`add parent-1 ${key} l`, `remove parent-1 ${key}`])
  })

  it('serves a finished run as turns: the task, then stdout as the report', async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'Fix the bug.', cwd: work, label: 'fix bug' })
    await until(() => delivered.length === 1)
    const turns = r.history(key)!
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(turns[0].content).toBe('Fix the bug.')
    expect(turns[1]).toMatchObject({ content: expect.stringMatching(/^Fixed it\./), workItems: [] })
    expect(turns[1].streaming).toBeFalsy()
    expect(r.record(key)).toMatchObject({ status: 'completed', parentKey: 'parent-1', adapter: 'pi', label: 'fix bug' })
    expect(r.records('parent-1').map((x) => x.sessionKey)).toEqual([key])
    expect(r.records('other')).toEqual([])
    expect(r.history('harness-00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(r.history('../../etc')).toBeNull()
  })

  it('serves a running run with its stdout so far as a streaming turn', async () => {
    fs.writeFileSync(path.join(bin, 'fake-harness'), '#!/bin/sh\necho "Looking at it."\nsleep 30\n', { mode: 0o755 })
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'Slow task', cwd: work })
    await until(() => (r.history(key)?.[1]?.content ?? '') !== '')
    const turns = r.history(key)!
    expect(turns[1]).toMatchObject({ role: 'assistant', content: 'Looking at it.', streaming: true })
    expect(r.record(key)?.status).toBe('working')
  })

  it("serves a finished Devin run from its ATIF export, ending on the transcript's report", async () => {
    const r = make({
      adapters: { pi: { ...fakeAdapter, transcript: devinAdapter.transcript, textStdout: true } }
    })
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'Fix the off-by-one.', cwd: work })
    await until(() => delivered.length === 1)
    fs.copyFileSync(
      path.join(import.meta.dirname, 'atif.fixture.json'),
      path.join(dataDir, 'agent-backend', 'harness', key, 'export')
    )
    const turns = r.history(key)!
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant'])
    expect(turns[0].content).toBe('Fix the off-by-one.')
    expect(turns[1].workItems.filter((w) => w.type === 'tool_call').map((w) => w.name)).toEqual([
      'read_file',
      'mcp__code__edit'
    ])
    // The report is the transcript's last message: not repeated after it.
    expect(turns[2].content).toMatch(/^Fixed the loop bound/)
  })

  it('serves a failed run with the error as a closing system turn', async () => {
    const r = make()
    const key = await r.spawn('parent-1', { harness: 'fake', task: 'FAIL', cwd: work })
    await until(() => delivered.length === 1)
    const turns = r.history(key)!
    const last = turns[turns.length - 1]
    expect(last).toMatchObject({ role: 'system', kind: { variant: 'agent-error', label: 'Subagent failed' } })
    expect(last.content).toMatch(/^Run finished with an error: pi exited with code 1/)
    expect(last.content).toContain('boom: model refused')
    expect(r.record(key)?.status).toBe('failed')
  })

  it('marks a run a restart cut off as failed in its record and emits subagent.failed', async () => {
    const first = make()
    const key = await first.spawn('parent-1', { harness: 'fake', task: 'HANG', cwd: work, label: 'long job' })
    first.dispose()
    events = []
    const second = make()
    second.recoverInterrupted()
    expect(events.map((e) => e.name)).toEqual(['subagent.failed'])
    expect(events[0].data).toMatchObject({
      parentKey: 'parent-1',
      childKey: key,
      error: 'cut off by a Sovereign restart'
    })
    expect(second.record(key)).toMatchObject({ status: 'failed', error: 'cut off by a Sovereign restart' })
    const turns = second.history(key)!
    expect(turns[turns.length - 1].content).toMatch(/cut off by a Sovereign restart/)
  })

  it.runIf(fs.existsSync('/usr/bin/bwrap'))('runs under bwrap: credentials hidden, cwd writable', async () => {
    fs.mkdirSync(path.join(home, '.ssh'))
    fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'KEY')
    profiles.fake.sandbox = 'bwrap'
    const r = make({ pathEnv: `${bin}${path.delimiter}/usr/bin` })
    await r.spawn('p', { harness: 'fake', task: 't', cwd: work })
    await until(() => delivered.length === 1)
    expect(delivered[0][1]).toMatch(/^\[Subagent done/)
    expect(delivered[0][1]).not.toContain('saw ssh key')
    expect(fs.existsSync(path.join(work, '.fake-env'))).toBe(true)
  })
})
