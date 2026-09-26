// End to end against the real `codegraph` CLI and the real files watcher:
// an edit, a branch switch and a new worktree must each reach the index.
// Skipped where codegraph is not installed.

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createMultiRootFileWatcher, type FileWatcher } from '@sovereign/files'
import { createCodeIndex, type CodeIndex } from './code-index.js'

const hasCodegraph = spawnSync('codegraph', ['--version']).status === 0

let tmp: string | undefined
let watcher: FileWatcher | undefined
let index: CodeIndex | undefined

afterEach(() => {
  index?.stop()
  watcher?.stop()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' })

function has(root: string, symbol: string): boolean {
  const out = execFileSync('codegraph', ['query', symbol, '-p', root, '-j'], { encoding: 'utf-8' })
  return (JSON.parse(out) as Array<{ node: { name: string } }>).some((r) => r.node.name === symbol)
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!hasCodegraph)('code index with the real codegraph CLI', () => {
  it('reindexes an edit, a branch switch and a new worktree', { timeout: 60_000 }, async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-live-')))
    const org = path.join(tmp, 'org')
    const repo = path.join(org, 'app')
    fs.mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() { return 1 }\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'main')
    git(repo, 'checkout', '-qb', 'feat')
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function beta() { return 2 }\n')
    git(repo, 'commit', '-qam', 'feat')
    git(repo, 'checkout', '-q', 'main')
    execFileSync('codegraph', ['init', repo], { stdio: 'ignore' })
    expect(has(repo, 'alpha')).toBe(true)

    const bus = createEventBus(path.join(tmp, 'data'))
    watcher = createMultiRootFileWatcher(bus, [org])
    watcher.start()
    await watcher.ready()
    index = createCodeIndex({ bus, getOrgRoots: () => [org], debounceMs: 100 })
    await index.start()
    expect(index.status().roots.map((r) => r.root)).toEqual([repo])

    // An edit.
    fs.appendFileSync(path.join(repo, 'a.ts'), 'export function gamma() { return 3 }\n')
    await waitFor(() => has(repo, 'gamma'))

    // A branch switch: the checkout rewrites a.ts on disk, git status stays clean.
    git(repo, 'checkout', '-qf', 'feat')
    await waitFor(() => has(repo, 'beta') && !has(repo, 'alpha'))

    // A new worktree of the indexed repo gets its own index, no manual init.
    const wt = path.join(org, 'app-wt')
    git(repo, 'worktree', 'add', '-q', wt, 'main')
    await waitFor(() => fs.existsSync(path.join(wt, '.codegraph', 'codegraph.db')) && has(wt, 'alpha'))
    expect(index.status().roots.map((r) => r.root)).toEqual([repo, wt])
  })
})
