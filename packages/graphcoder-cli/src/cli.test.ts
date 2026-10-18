import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT_ERROR, EXIT_OK, findIndexedRoot, runCli } from './cli.js'

const hasCodegraph = spawnSync('codegraph', ['--version']).status === 0
const here = path.dirname(fileURLToPath(import.meta.url))

let tmp: string | undefined
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

/** A two-file TypeScript checkout indexed by the codegraph CLI */
function indexedRepo(): string {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-cli-')))
  const repo = path.join(tmp, 'app')
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export function alpha(): number {\n  return 1\n}\n')
  fs.writeFileSync(
    path.join(repo, 'src', 'deep', 'b.ts'),
    "import { alpha } from '../a.js'\nexport const beta = () => alpha() + 1\n"
  )
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('codegraph', ['init', repo], { stdio: 'ignore' })
  return repo
}

function run(argv: string[], cwd: string) {
  const out: string[] = []
  const err: string[] = []
  return runCli(argv, { out: (t) => out.push(t), err: (t) => err.push(t), cwd }).then((code) => ({
    code,
    out: out.join('\n'),
    err: err.join('\n')
  }))
}

describe.skipIf(!hasCodegraph)('graphcoder stats', () => {
  it('prints the counts of the checkout holding the path, found by walking up', async () => {
    const repo = indexedRepo()
    const status = JSON.parse(execFileSync('codegraph', ['status', '-j', repo], { encoding: 'utf-8' }))
    const res = await run(['stats', 'src/deep'], repo)
    expect(res.code).toBe(EXIT_OK)
    expect(res.out.split('\n')).toEqual([
      repo,
      `  nodes  ${status.nodeCount}`,
      `  edges  ${status.edgeCount}`,
      `  files  ${status.fileCount}`,
      `  kinds  ${Object.entries(status.nodesByKind as Record<string, number>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`
    ])
    expect(findIndexedRoot(path.join(repo, 'src', 'a.ts'))).toBe(repo)
  })

  it('prints JSON with --json, defaulting to the working directory', async () => {
    const repo = indexedRepo()
    const res = await run(['stats', '--json'], path.join(repo, 'src'))
    expect(res.code).toBe(EXIT_OK)
    expect(JSON.parse(res.out)).toMatchObject({ path: repo, fileCount: 2, nodesByKind: { function: 2 } }) // alpha, and the arrow function beta
  })

  it('runs as a process with exit codes 0 and 2', () => {
    const repo = indexedRepo()
    const tsx = path.resolve(here, '../../../node_modules/.bin/tsx')
    const bin = path.join(here, 'index.ts')
    const ok = spawnSync(tsx, [bin, 'stats', repo], { encoding: 'utf-8' })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('nodes')
    const missing = spawnSync(tsx, [bin, 'stats', tmp!], { encoding: 'utf-8' })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toMatch(/no CodeGraph index/)
  })
})

describe('graphcoder usage errors', () => {
  it('exits 2 with no index, an unknown command, a bad option or no command', async () => {
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-cli-empty-')))
    tmp = empty
    expect((await run(['stats'], empty)).code).toBe(EXIT_ERROR)
    expect((await run(['frobnicate'], empty)).err).toMatch(/unknown command frobnicate/)
    expect((await run(['frobnicate'], empty)).code).toBe(EXIT_ERROR)
    expect((await run(['stats', '--yaml'], empty)).code).toBe(EXIT_ERROR)
    expect((await run(['stats', 'a', 'b'], empty)).code).toBe(EXIT_ERROR)
    expect((await run([], empty)).code).toBe(EXIT_ERROR)
    const help = await run(['help'], empty)
    expect(help.code).toBe(EXIT_OK)
    expect(help.out).toMatch(/stats \[path\]/)
  })
})
