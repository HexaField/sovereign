import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDevinCommand,
  createDevinExecutor,
  findDevinBinary,
  resolveDevinCwd,
  stripDevinBanner,
  trustWorkspace,
  type DevinExecutor
} from './executor.js'

let tmp: string
let home: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devin-exec-test-')))
  home = path.join(tmp, 'home')
  fs.mkdirSync(path.join(home, 'workspaces', 'coasys', 'ad4m'), { recursive: true })
  fs.mkdirSync(path.join(home, 'workspaces', 'hexafield', 'sovereign'), { recursive: true })
  fs.mkdirSync(path.join(home, '.sovereign', 'data'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveDevinCwd', () => {
  const roots = ['~/workspaces/coasys']

  it('allows a directory under an allowed root and returns its real path', () => {
    expect(resolveDevinCwd('~/workspaces/coasys/ad4m', { home, allowedRoots: roots })).toBe(
      path.join(home, 'workspaces', 'coasys', 'ad4m')
    )
    expect(resolveDevinCwd(path.join(home, 'workspaces', 'coasys'), { home, allowedRoots: roots })).toBe(
      path.join(home, 'workspaces', 'coasys')
    )
  })

  it('refuses a directory outside every allowed root', () => {
    expect(() => resolveDevinCwd(path.join(home, 'workspaces'), { home, allowedRoots: roots })).toThrow(/allowedRoots/)
    // A sibling whose name starts with the root's name is not inside it.
    fs.mkdirSync(path.join(home, 'workspaces', 'coasys-private'))
    expect(() => resolveDevinCwd('~/workspaces/coasys-private', { home, allowedRoots: roots })).toThrow(/allowedRoots/)
  })

  it('refuses a `..` path that leaves the allowed root', () => {
    expect(() => resolveDevinCwd('~/workspaces/coasys/../hexafield/sovereign', { home, allowedRoots: roots })).toThrow(
      /private/
    )
    expect(() => resolveDevinCwd('~/workspaces/coasys/ad4m/../..', { home, allowedRoots: roots })).toThrow(
      /allowedRoots/
    )
  })

  it('refuses a symlink inside an allowed root that points at a private directory', () => {
    const link = path.join(home, 'workspaces', 'coasys', 'sneaky')
    fs.symlinkSync(path.join(home, 'workspaces', 'hexafield', 'sovereign'), link)
    expect(() => resolveDevinCwd(link, { home, allowedRoots: roots })).toThrow(/private/)
  })

  it('allows a symlink outside the root that points into it', () => {
    const link = path.join(tmp, 'shortcut')
    fs.symlinkSync(path.join(home, 'workspaces', 'coasys', 'ad4m'), link)
    expect(resolveDevinCwd(link, { home, allowedRoots: roots })).toBe(path.join(home, 'workspaces', 'coasys', 'ad4m'))
  })

  it('refuses ~/.sovereign and ~/workspaces/hexafield even when the allowlist names them', () => {
    const wide = ['~']
    expect(() => resolveDevinCwd('~/.sovereign/data', { home, allowedRoots: wide })).toThrow(/private/)
    expect(() => resolveDevinCwd('~/workspaces/hexafield/sovereign', { home, allowedRoots: wide })).toThrow(/private/)
    expect(() => resolveDevinCwd('~/workspaces/hexafield', { home, allowedRoots: ['~/workspaces/hexafield'] })).toThrow(
      /private/
    )
  })

  it('refuses the extra denied roots it is given', () => {
    expect(() =>
      resolveDevinCwd('~/workspaces/coasys/ad4m', {
        home,
        allowedRoots: roots,
        deniedRoots: [path.join(home, 'workspaces', 'coasys')]
      })
    ).toThrow(/private/)
  })

  it('refuses a cwd that does not exist or is not a directory', () => {
    expect(() => resolveDevinCwd('~/workspaces/coasys/missing', { home, allowedRoots: roots })).toThrow(
      /not a directory/
    )
    fs.writeFileSync(path.join(home, 'workspaces', 'coasys', 'file.txt'), 'x')
    expect(() => resolveDevinCwd('~/workspaces/coasys/file.txt', { home, allowedRoots: roots })).toThrow(
      /not a directory/
    )
  })
})

describe('trustWorkspace', () => {
  it('creates the trust file when it is missing', () => {
    const file = path.join(home, '.local', 'share', 'devin', 'cli', 'trusted_workspaces.json')
    trustWorkspace(file, '/work/a')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ trusted_paths: ['/work/a'] })
  })

  it('adds the directory once and keeps the other entries and fields', () => {
    const file = path.join(tmp, 'trusted_workspaces.json')
    fs.writeFileSync(file, JSON.stringify({ trusted_paths: ['/work/old'], other: 1 }))
    trustWorkspace(file, '/work/a')
    trustWorkspace(file, '/work/a')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ trusted_paths: ['/work/old', '/work/a'], other: 1 })
    // Written through a temp file and a rename: no temp file stays behind.
    expect(fs.readdirSync(tmp).filter((f) => f.startsWith('trusted_workspaces.json.'))).toEqual([])
  })

  it('refuses to overwrite a trust file it cannot parse', () => {
    const file = path.join(tmp, 'trusted_workspaces.json')
    fs.writeFileSync(file, '{ broken')
    expect(() => trustWorkspace(file, '/work/a')).toThrow()
    expect(fs.readFileSync(file, 'utf8')).toBe('{ broken')
  })
})

describe('stripDevinBanner', () => {
  it('removes the login banner and the sandbox warning before the answer', () => {
    const out = [
      'Logged in as alex@example.com',
      'Organization: Example',
      'Plan: free',
      '',
      'Warning: --sandbox always uses the autonomous permission mode; ignoring --permission-mode dangerous.',
      'Fixed the off-by-one in sum.mjs.',
      '',
      'Tests pass.'
    ].join('\n')
    expect(stripDevinBanner(out)).toBe('Fixed the off-by-one in sum.mjs.\n\nTests pass.')
  })

  it('keeps an answer that has no banner, and drops ANSI codes and carriage returns', () => {
    expect(stripDevinBanner('OK\n')).toBe('OK')
    expect(stripDevinBanner('\u001b[1mDone\u001b[0m\r\nLogged in as is part of the answer here\r\n')).toBe(
      'Done\nLogged in as is part of the answer here'
    )
  })

  it('removes a lone login line with no blank line after it', () => {
    expect(stripDevinBanner('Logged in as alex@example.com\nThe answer')).toBe('The answer')
  })
})

describe('buildDevinCommand', () => {
  it('runs print mode with the locked-down config, sandbox, model, prompt file and export', () => {
    const cmd = buildDevinCommand({
      bin: '/opt/bin/devin',
      configFile: '/h/.config/devin/executor.json',
      briefFile: '/tmp/b/brief.md',
      model: 'swe-2-medium',
      exportFile: '/data/agent-backend/devin/run.md',
      env: {
        PATH: '/usr/bin',
        HOME: '/h',
        SSH_AUTH_SOCK: '/run/ssh.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
        GH_TOKEN: 'gh',
        GITHUB_TOKEN: 'gh2',
        DEVIN_PERMISSION_MODE: 'dangerous',
        LANG: 'en_AU.UTF-8',
        SOME_NEW_API_KEY: 'leak',
        XAUTHORITY: '/run/x'
      }
    })
    expect(cmd.command).toBe('/opt/bin/devin')
    expect(cmd.args).toEqual([
      '--config',
      '/h/.config/devin/executor.json',
      '-p',
      '--prompt-file',
      '/tmp/b/brief.md',
      '--model',
      'swe-2-medium',
      '--sandbox',
      '--export',
      '/data/agent-backend/devin/run.md'
    ])
    // Only the variables a build needs pass: a secret added to the server's env later never reaches Devin.
    expect(cmd.env).toEqual({ PATH: '/usr/bin', HOME: '/h', LANG: 'en_AU.UTF-8' })
  })
})

describe('findDevinBinary', () => {
  it('finds devin on PATH, then in ~/.local/bin, else returns null', () => {
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    expect(findDevinBinary(bin, home)).toBeNull()
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, '.local', 'bin', 'devin'), '#!/bin/sh\n', { mode: 0o755 })
    expect(findDevinBinary(bin, home)).toBe(path.join(home, '.local', 'bin', 'devin'))
    fs.writeFileSync(path.join(bin, 'devin'), '#!/bin/sh\n', { mode: 0o755 })
    expect(findDevinBinary(bin, home)).toBe(path.join(bin, 'devin'))
  })

  it('skips a devin that is not executable', () => {
    const bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'devin'), 'x', { mode: 0o644 })
    expect(findDevinBinary(bin, home)).toBeNull()
  })
})

// ── The executor, against a fake `devin` ─────────────────────────────────────

/** A fake CLI: answers from the brief. "FAIL" in the brief exits 1, "HANG" sleeps. */
const FAKE_DEVIN = `#!/bin/sh
brief=""; export_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prompt-file) brief="$2"; shift 2 ;;
    --export) export_file="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$*" > /dev/null
echo "Logged in as alex@example.com"
echo "Organization: Example"
echo "Plan: free"
echo ""
echo "Warning: --sandbox always uses the autonomous permission mode; ignoring --permission-mode dangerous." >&2
pwd > "$PWD/.fake-devin-cwd"
env > "$PWD/.fake-devin-env"
[ -n "$export_file" ] && echo "# transcript" > "$export_file"
if grep -q HANG "$brief"; then sleep 30; fi
if grep -q FAIL "$brief"; then echo "boom: model refused" >&2; exit 1; fi
echo "Fixed it."
echo "Brief had: $(grep -c 'never commit' "$brief") never-commit line(s)"
`

describe('createDevinExecutor', () => {
  let bin: string
  let work: string
  let dataDir: string
  let delivered: Array<[string, string]>
  let executor: DevinExecutor | undefined

  beforeEach(() => {
    bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'devin'), FAKE_DEVIN, { mode: 0o755 })
    fs.mkdirSync(path.join(home, '.config', 'devin'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'devin', 'executor.json'), '{}')
    work = path.join(home, 'workspaces', 'coasys', 'ad4m')
    dataDir = path.join(tmp, 'data')
    delivered = []
  })

  afterEach(() => {
    executor?.dispose()
    executor = undefined
  })

  function make(overrides: Partial<Parameters<typeof createDevinExecutor>[0]> = {}): DevinExecutor {
    executor = createDevinExecutor({
      dataDir,
      home,
      settings: () => ({ defaultModel: 'swe-2-high', allowedRoots: ['~/workspaces/coasys'] }),
      deliver: (parentKey, text) => delivered.push([parentKey, text]),
      pathEnv: bin,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, SSH_AUTH_SOCK: '/run/ssh.sock' },
      ...overrides
    })
    return executor
  }

  async function until(check: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  it('runs a task, lists it while it works, then delivers [Subagent done] and drops it', async () => {
    const ex = make()
    const key = await ex.spawn('parent-1', { task: 'Fix the bug. HANG', cwd: work, label: 'fix bug' })
    expect(ex.list()).toEqual([
      expect.objectContaining({ sessionKey: key, label: 'fix bug', status: 'working', task: 'Fix the bug. HANG' })
    ])
    expect(ex.list('parent-1')).toHaveLength(1)
    expect(ex.list('other-parent')).toHaveLength(0)
    expect(ex.has(key)).toBe(true)

    await ex.stop(key)
    await until(() => delivered.length === 1)
    expect(delivered[0][0]).toBe('parent-1')
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: fix bug\] after 1 min — stopped by the parent/)
    expect(ex.list()).toEqual([])
    expect(ex.has(key)).toBe(false)
  })

  it('delivers the stdout answer without the banner on exit 0, with the transcript path', async () => {
    const ex = make()
    const key = await ex.spawn('parent-1', { task: 'Fix the bug.', cwd: work, label: 'fix bug' })
    await until(() => delivered.length === 1)
    const [parent, text] = delivered[0]
    expect(parent).toBe('parent-1')
    expect(text).toMatch(/^\[Subagent done: fix bug\] after 1 min\n\nFixed it\.\n/)
    expect(text).not.toMatch(/Logged in as|Organization|Warning:/)
    expect(text).toMatch(/Brief had: [1-9]\d* never-commit line\(s\)/)
    const transcript = path.join(dataDir, 'agent-backend', 'devin', `${key}.json`)
    expect(text).toContain(`Transcript: ${transcript}`)
    expect(text).toMatch(new RegExp(`Session: ${key}$`))
    expect(fs.readFileSync(transcript, 'utf8')).toBe('# transcript\n')
    expect(ex.list()).toEqual([])

    // The run's cwd was trusted (real path) and the child ran there without the SSH agent.
    expect(fs.readFileSync(path.join(work, '.fake-devin-cwd'), 'utf8').trim()).toBe(work)
    expect(fs.readFileSync(path.join(work, '.fake-devin-env'), 'utf8')).not.toContain('SSH_AUTH_SOCK')
    const trust = JSON.parse(
      fs.readFileSync(path.join(home, '.local', 'share', 'devin', 'cli', 'trusted_workspaces.json'), 'utf8')
    )
    expect(trust.trusted_paths).toEqual([work])
  })

  it('delivers [Subagent failed] with the exit code and the stderr tail on a non-zero exit', async () => {
    const ex = make()
    await ex.spawn('parent-1', { task: 'FAIL please', cwd: work, label: 'doomed' })
    await until(() => delivered.length === 1)
    const text = delivered[0][1]
    expect(text).toMatch(/^\[Subagent failed: doomed\] after 1 min — devin exited with code 1/)
    expect(text).toContain('boom: model refused')
    expect(ex.list()).toEqual([])
  })

  it('stops a run at its time limit', async () => {
    const ex = make()
    await ex.spawn('parent-1', { task: 'HANG', cwd: work, label: 'slow', timeoutMs: 200 })
    await until(() => delivered.length === 1)
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: slow\] after 1 min — timed out after 1 min/)
  })

  it('refuses a private cwd, a missing binary and a missing executor config before starting anything', async () => {
    const ex = make()
    await expect(ex.spawn('p', { task: 't', cwd: '~/workspaces/hexafield/sovereign' })).rejects.toThrow(/private/)
    await expect(ex.spawn('p', { task: 't', cwd: '~/.sovereign' })).rejects.toThrow(/private/)
    await expect(ex.spawn('p', { task: 't' })).rejects.toThrow(/cwd/)

    const noBin = make({ pathEnv: path.join(tmp, 'empty') })
    await expect(noBin.spawn('p', { task: 't', cwd: work })).rejects.toThrow(/devin.*not found/)

    fs.rmSync(path.join(home, '.config', 'devin', 'executor.json'))
    const noConfig = make()
    await expect(noConfig.spawn('p', { task: 't', cwd: work })).rejects.toThrow(/executor\.json/)
    expect(delivered).toEqual([])
  })

  it('caps running runs per parent', async () => {
    const ex = make()
    for (let i = 0; i < 4; i++) await ex.spawn('p', { task: 'HANG', cwd: work })
    await expect(ex.spawn('p', { task: 'HANG', cwd: work })).rejects.toThrow(/max 4/)
    await ex.spawn('other', { task: 'HANG', cwd: work })
    expect(ex.list()).toHaveLength(5)
  })

  it('tells the parent about a run a restart cut off, once', async () => {
    const first = make()
    const key = await first.spawn('parent-1', { task: 'HANG', cwd: work, label: 'long job' })
    // Sovereign goes down without finishing the run.
    first.dispose()
    expect(delivered).toEqual([])

    const second = make()
    second.recoverInterrupted()
    expect(delivered).toHaveLength(1)
    expect(delivered[0][0]).toBe('parent-1')
    expect(delivered[0][1]).toMatch(/^\[Subagent failed: long job\] after \d+ min — cut off by a Sovereign restart/)
    expect(delivered[0][1]).toContain(`Session: ${key}`)
    make().recoverInterrupted()
    expect(delivered).toHaveLength(1)
  })
})
