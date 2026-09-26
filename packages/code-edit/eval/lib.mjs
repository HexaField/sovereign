// Shared helpers for the symbol-edit evaluation: shell calls, task checkouts,
// test runs. A task is a commit of the target repo that changes source files
// and tests; its checkout holds the parent commit plus the commit's tests.

import { spawn } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

/** Run a command; resolve { code, stdout, stderr, timedOut }. Never rejects. */
export function sh(cmd, args, { cwd, env, timeoutMs = 600_000, input, stdoutFile } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    const sink = stdoutFile ? fs.createWriteStream(stdoutFile) : null
    child.stdout.on('data', (d) => {
      if (sink) sink.write(d)
      else stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-20_000)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL') // the whole process group: MCP servers too
      } catch {}
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: String(err), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      sink?.end()
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
    child.stdin.on('error', () => {}) // a child that exits without reading its stdin
    child.stdin.end(input ?? '')
  })
}

export async function git(cwd, ...args) {
  const r = await sh('git', args, { cwd })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout
}

const TEST = /\.test\.tsx?$/
const SOURCE = /^packages\/[^/]+\/src\/.*\.tsx?$/

/** The commit's changed test files and changed non-test source files. */
export async function taskFiles(repo, sha) {
  const out = await git(repo, 'diff-tree', '--no-commit-id', '-r', '--name-only', sha)
  const files = out.split('\n').filter(Boolean)
  return { tests: files.filter((f) => TEST.test(f)), src: files.filter((f) => SOURCE.test(f) && !TEST.test(f)) }
}

/**
 * A checkout of `parent` with nothing after it in its history, dependencies
 * installed and every workspace package built (vitest resolves workspace
 * packages from dist/). Returns the seconds each step took.
 */
export async function prepareCheckout({ repo, parent, dir }) {
  const t = {}
  const step = async (name, fn) => {
    const start = Date.now()
    await fn()
    t[name] = (Date.now() - start) / 1000
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  await step('clone', async () => {
    const r = await sh('git', ['clone', '-q', '--no-local', '--depth', '1', `--revision=${parent}`, `file://${repo}`, dir])
    if (r.code !== 0) throw new Error(`clone: ${r.stderr}`)
  })
  await step('submodules', async () => {
    const mods = path.join(repo, '.git', 'modules')
    const list = await sh('git', ['config', '-f', '.gitmodules', '--get-regexp', 'path'], { cwd: dir })
    for (const line of list.stdout.split('\n').filter(Boolean)) {
      const sub = line.split(' ')[1]
      await git(dir, 'config', `submodule.${sub}.url`, `file://${path.join(mods, sub)}`)
    }
    const r = await sh('git', ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init'], { cwd: dir })
    if (r.code !== 0) throw new Error(`submodules: ${r.stderr}`)
  })
  await step('install', async () => {
    const r = await sh('pnpm', ['install', '--offline', '--frozen-lockfile'], { cwd: dir })
    if (r.code !== 0) throw new Error(`pnpm install: ${r.stderr.slice(-2000)}`)
    // pnpm skips install scripts; borrow native builds from the source checkout.
    for (const pkg of fs.readdirSync(path.join(dir, 'node_modules', '.pnpm'))) {
      const from = path.join(repo, 'node_modules', '.pnpm', pkg)
      for (const name of fs.existsSync(path.join(from, 'node_modules')) ? walkBuilds(path.join(from, 'node_modules')) : []) {
        const rel = path.relative(from, name)
        const to = path.join(dir, 'node_modules', '.pnpm', pkg, rel)
        if (!fs.existsSync(to)) fs.cpSync(name, to, { recursive: true })
      }
    }
    if (fs.existsSync(path.join(repo, '.certs'))) fs.symlinkSync(path.join(repo, '.certs'), path.join(dir, '.certs'))
  })
  await step('build', async () => {
    const r = await sh('pnpm', ['run', 'build'], { cwd: dir, timeoutMs: 900_000 })
    if (r.code !== 0) throw new Error(`build: ${(r.stdout + r.stderr).slice(-3000)}`)
  })
  await step('index', async () => {
    await sh('codegraph', ['init', dir], { timeoutMs: 300_000 })
  })
  return t
}

/** `build/Release` directories of native modules under a node_modules tree (one level of scope). */
function walkBuilds(nm) {
  const out = []
  for (const entry of fs.readdirSync(nm)) {
    const pkgs = entry.startsWith('@') ? fs.readdirSync(path.join(nm, entry)).map((p) => path.join(nm, entry, p)) : [path.join(nm, entry)]
    for (const p of pkgs) {
      const build = path.join(p, 'build')
      if (fs.existsSync(path.join(build, 'Release'))) out.push(build)
    }
  }
  return out
}

/** Write the task commit's versions of its test files into the checkout. */
export async function writeTests(repo, sha, dir, tests) {
  for (const f of tests) {
    const content = await git(repo, 'show', `${sha}:${f}`)
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), content)
  }
}

export async function runTests(dir, tests, timeoutMs = 600_000) {
  const r = await sh('npx', ['vitest', 'run', ...tests], { cwd: dir, timeoutMs })
  const text = stripVTControlCharacters(r.stdout + r.stderr)
  const summary = /Tests\s+([^\n]+)/.exec(text)?.[1]?.trim() ?? (r.timedOut ? 'timed out' : 'no summary')
  return { pass: r.code === 0 && !r.timedOut, summary }
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}
