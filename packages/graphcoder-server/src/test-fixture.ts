// Test support: a copy of the tiny-ts fixture project, committed to git and
// indexed by the real `codegraph` CLI, in a fresh temporary directory.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseUnifiedDiff, type GitPort } from '@sovereign/graphcoder-core'

export const hasCodegraphCli = spawnSync('codegraph', ['--version']).status === 0

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test-fixtures/tiny-ts')

export function indexedFixture(): { root: string; repo: string; cleanup(): void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-fixture-')))
  const repo = path.join(root, 'tiny-ts')
  fs.cpSync(FIXTURE, repo, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore'
    })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'fixture')
  execFileSync('codegraph', ['init', repo], { stdio: 'ignore' })
  return { root, repo, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** A git-CLI GitPort with checkouts under `checkoutsDir`, recording what it is asked */
export function cliGitPort(checkoutsDir: string): GitPort & { calls: string[] } {
  const calls: string[] = []
  const run = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const tryRun = (cwd: string, ...args: string[]) => {
    try {
      return run(cwd, ...args)
    } catch {
      return null
    }
  }
  let n = 0
  return {
    calls,
    resolve: async (repo, ref) => tryRun(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`),
    mergeBase: async (repo, a, b) => tryRun(repo, 'merge-base', a, b),
    fetch: async (_repo, refs) => {
      calls.push(`fetch ${refs.join(' ')}`)
    },
    diffRefs: async (repo, base, head) =>
      parseUnifiedDiff(run(repo, 'diff', '-U0', '-M', '--no-color', `${base}...${head}`)),
    checkout: async (repo, ref) => {
      const dir = path.join(checkoutsDir, `co-${++n}`)
      calls.push(`checkout ${ref}`)
      run(repo, 'worktree', 'add', '-q', '--detach', dir, ref)
      return {
        path: dir,
        switchTo: async (to) => {
          calls.push(`switch ${to}`)
          run(dir, 'checkout', '-q', '--detach', to)
        },
        release: async () => {
          calls.push('release')
          run(repo, 'worktree', 'remove', '--force', dir)
        }
      }
    },
    log: async () => []
  }
}

/**
 * The fixture with a change on top: `main` adds a test of `add`; branch `feature` then edits `add`, adds `negate`
 * and removes `multiply` (and `scale`, its only caller). Returns both shas.
 */
export function fixtureWithChange(): ReturnType<typeof indexedFixture> & { main: string; feature: string } {
  const fx = indexedFixture()
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: fx.repo,
      encoding: 'utf-8'
    }).trim()
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(fx.repo, rel), text)
  write(
    'src/math.test.ts',
    `import { describe, expect, it } from 'vitest'
import { add } from './math.js'

describe('math', () => {
  it('adds', () => {
    expect(add(1, 2)).toBe(3)
  })
})
`
  )
  git('add', '-A')
  git('commit', '-qm', 'test add')
  const main = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'feature')
  write(
    'src/math.ts',
    `export function add(a: number, b: number): number {
  const sum = b + a
  return sum
}

export function negate(a: number): number {
  return -a
}
`
  )
  write(
    'src/geometry.ts',
    `import { add } from './math.js'

export class Point {
  constructor(
    readonly x: number,
    readonly y: number
  ) {}

  translate(dx: number, dy: number): Point {
    return new Point(add(this.x, dx), add(this.y, dy))
  }
}
`
  )
  write('src/index.ts', `export { add, negate } from './math.js'\nexport { Point } from './geometry.js'\n`)
  git('commit', '-qam', 'change math')
  const feature = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  return { ...fx, main, feature }
}

const conceptPage = (title: string, model: string, where: string, parent = '[Tiny](README.md)') =>
  `# ${title}\n\n${model}\n\n**Why:** It is small.\n\n**Parent:** ${parent}\n\n<details><summary>Where in the code</summary>\n\n${where}\n\n</details>\n`

/**
 * The fixture with a concept tree: commit `before` has none; `main` adds `mental-models/` (the root claims `src/`,
 * Math claims math.ts with `add` and `multiply`, Geometry claims geometry.ts with `Point`, a name that resolves to
 * nothing and a stale link). Branch `change` then adds `negate` to math.ts (Math's page unchanged), rewrites
 * Geometry's model, and adds a Vectors page that claims no code.
 */
export function fixtureWithConcepts(): ReturnType<typeof indexedFixture> & {
  before: string
  main: string
  change: string
} {
  const fx = indexedFixture()
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: fx.repo,
      encoding: 'utf-8'
    }).trim()
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(fx.repo, rel)), { recursive: true })
    fs.writeFileSync(path.join(fx.repo, rel), text)
  }
  const before = git('rev-parse', 'HEAD')
  write(
    'mental-models/README.md',
    conceptPage('Tiny', 'Tiny does arithmetic on points.', '- [src/](../src): all of it.', 'none').replace(
      '<details>',
      '## Parts\n- [Math](math.md): numbers.\n- [Geometry](geometry.md): points.\n\n<details>'
    )
  )
  write(
    'mental-models/math.md',
    conceptPage('Math', 'Math adds and multiplies numbers.', '- [math.ts](../src/math.ts): `add`, `multiply`.')
  )
  const geometry = (model: string) =>
    conceptPage(
      'Geometry',
      model,
      '- [geometry.ts](../src/geometry.ts): `Point`, `Vector`.\n- [gone.ts](../src/gone.ts): an old file.'
    )
  write('mental-models/geometry.md', geometry('A point moves by adding to its coordinates.'))
  git('add', '-A')
  git('commit', '-qm', 'concepts')
  const main = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'change')
  fs.appendFileSync(
    path.join(fx.repo, 'src/math.ts'),
    '\nexport function negate(a: number): number {\n  return -a\n}\n'
  )
  write('mental-models/geometry.md', geometry('A point moves and scales.'))
  write('mental-models/vectors.md', conceptPage('Vectors', 'Vectors are not built yet.', '- None.'))
  git('add', '-A')
  git('commit', '-qm', 'negate')
  const change = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  return { ...fx, before, main, change }
}

/** `codegraph status -j`: the CLI's own counts, to check the reader against */
export function cliStatus(repo: string): {
  nodeCount: number
  edgeCount: number
  fileCount: number
  nodesByKind: Record<string, number>
} {
  return JSON.parse(execFileSync('codegraph', ['status', '-j', repo], { encoding: 'utf-8' }))
}
