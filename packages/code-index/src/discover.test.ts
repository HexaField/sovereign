import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverRoots } from './discover.js'

let tmp: string
let org: string

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' })

function markIndexed(dir: string): void {
  fs.mkdirSync(path.join(dir, '.codegraph'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.codegraph', 'codegraph.db'), '')
}

function repo(rel: string, indexed: boolean): string {
  const dir = path.join(org, rel)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  if (indexed) markIndexed(dir)
  return dir
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-discover-')))
  org = path.join(tmp, 'org')
  fs.mkdirSync(org)
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('discoverRoots', () => {
  it('finds indexed checkouts up to two levels below an org root', async () => {
    const a = repo('a', true)
    repo('b', false)
    const c = repo('group/c', true)
    repo('group/sub/d', true) // three levels down
    repo('node_modules/x', true) // ignored name
    repo('.hidden/y', true) // dot directory

    expect(await discoverRoots([org])).toEqual({ indexed: [a, c], uninitialized: [] })
  })

  it('returns the worktrees of indexed repos and flags those without an index', async () => {
    const app = repo('app', true)
    const sibling = path.join(org, 'app-feat')
    const nested = path.join(app, '.worktrees', 'fix')
    git(app, 'worktree', 'add', '-q', sibling, '-b', 'feat')
    git(app, 'worktree', 'add', '-q', nested, '-b', 'fix')
    markIndexed(nested)
    git(app, 'worktree', 'add', '-q', path.join(tmp, 'outside'), '-b', 'out') // not under an org root

    const lib = repo('lib', false)
    git(lib, 'worktree', 'add', '-q', path.join(org, 'lib-wt'), '-b', 'wt') // its repo has no index

    expect(await discoverRoots([org])).toEqual({ indexed: [app, nested], uninitialized: [sibling] })
  })

  it('skips worktrees whose directory is gone', async () => {
    const app = repo('app', true)
    const gone = path.join(org, 'app-gone')
    git(app, 'worktree', 'add', '-q', gone, '-b', 'gone')
    fs.rmSync(gone, { recursive: true, force: true })

    expect(await discoverRoots([org])).toEqual({ indexed: [app], uninitialized: [] })
  })

  it('tolerates org roots that do not exist', async () => {
    expect(await discoverRoots([path.join(tmp, 'missing')])).toEqual({ indexed: [], uninitialized: [] })
  })
})
