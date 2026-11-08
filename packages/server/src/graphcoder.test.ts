import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitCli } from '@sovereign/git'
import { worktreeList } from '@sovereign/worktrees'
import { createCodeIndexGraphSource, createSovereignGitPort, mountGraphcoder } from './graphcoder.js'

let tmp: string | undefined
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Alex', ...args], {
    cwd,
    encoding: 'utf-8'
  }).trim()

/** A repo with main (two commits) and a feature branch, plus a data dir beside it */
function setup() {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-adapters-')))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'first')
  const first = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-qb', 'feature')
  fs.writeFileSync(path.join(repo, 'b.ts'), 'export const b = 2\n')
  git(repo, 'mv', 'a.ts', 'alpha.ts')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'feature work')
  git(repo, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'main.ts'), 'export const m = 3\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'main moves')
  const checkouts = path.join(tmp, 'data', 'graphcoder', 'checkouts')
  return { repo, first, checkouts, port: createSovereignGitPort(createGitCli(), checkouts) }
}

describe('Sovereign GitPort', () => {
  it('diffs head against its merge base with base', async () => {
    const { repo, port } = setup()
    const files = await port.diffRefs(repo, 'main', 'feature')
    expect(files.sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
      { path: 'alpha.ts', status: 'renamed', oldPath: 'a.ts', hunks: [] },
      { path: 'b.ts', status: 'added', hunks: [{ baseStart: 0, baseLines: 0, headStart: 1, headLines: 1 }] }
    ])
  })

  it('resolves refs to commits and finds merge bases', async () => {
    const { repo, first, port } = setup()
    expect(await port.resolve(repo, 'main')).toBe(git(repo, 'rev-parse', 'main'))
    expect(await port.resolve(repo, 'no-such-ref')).toBeNull()
    expect(await port.mergeBase(repo, 'main', 'feature')).toBe(first)
    git(repo, 'checkout', '-q', '--orphan', 'island')
    git(repo, 'commit', '-qm', 'unrelated')
    git(repo, 'checkout', '-q', 'main')
    expect(await port.mergeBase(repo, 'main', 'island')).toBeNull()
  })

  it('moves a checkout to another ref', async () => {
    const { repo, first, port } = setup()
    const checkout = await port.checkout(repo, first)
    try {
      await checkout.switchTo('feature')
      expect(git(checkout.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'feature'))
      expect(fs.readdirSync(checkout.path).sort()).toEqual(['.git', 'alpha.ts', 'b.ts'])
    } finally {
      await checkout.release()
    }
  })

  it('fetches a remote branch by its tracking name, and a commit it lacks by sha', async () => {
    const { repo, port } = setup()
    const clone = path.join(tmp!, 'clone')
    git(tmp!, 'clone', '-q', repo, clone)
    // upstream moves on: feature gains a commit, and a branch the clone never saw holds another
    git(repo, 'checkout', '-q', 'feature')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'more feature')
    git(repo, 'checkout', '-q', '-b', 'unseen')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'unseen work')
    const unseen = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-q', 'main')
    expect(await port.resolve(clone, unseen)).toBeNull()

    await port.fetch(clone, ['origin/feature', unseen, 'main'])
    expect(git(clone, 'rev-parse', 'origin/feature')).toBe(git(repo, 'rev-parse', 'feature'))
    expect(await port.resolve(clone, unseen)).toBe(unseen)
    await expect(port.fetch(clone, ['0'.repeat(40)])).rejects.toThrow()
  })

  it('checks a ref out into a temporary worktree under the data dir and releases it', async () => {
    const { repo, first, checkouts, port } = setup()
    const checkout = await port.checkout(repo, first)
    expect(path.dirname(checkout.path)).toBe(checkouts)
    expect(git(checkout.path, 'rev-parse', 'HEAD')).toBe(first)
    expect(fs.readdirSync(checkout.path).sort()).toEqual(['.git', 'a.ts'])
    // the user's checkout is untouched: same branch, no new branch
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(git(repo, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['feature', 'main'])

    await checkout.release()
    await checkout.release()
    expect(fs.existsSync(checkout.path)).toBe(false)
    expect((await worktreeList(repo)).map((w) => w.worktree)).toEqual([repo])
  })

  it('never puts a checkout inside the repo it checks out', async () => {
    const { repo } = setup()
    const inside = createSovereignGitPort(createGitCli(), path.join(repo, '.data', 'checkouts'))
    await expect(inside.checkout(repo, 'main')).rejects.toThrow(/inside/)
    expect(fs.existsSync(path.join(repo, '.data'))).toBe(false)
  })

  it('refuses refs that git would read as options', async () => {
    const { repo, port } = setup()
    await expect(port.checkout(repo, '--orphan=x')).rejects.toThrow(/Not a git ref/)
    await expect(port.diffRefs(repo, 'main', '-p')).rejects.toThrow(/Not a git ref/)
    await expect(port.log(repo, { since: '--all' })).rejects.toThrow(/Not a git ref/)
    await expect(port.resolve(repo, '--all')).rejects.toThrow(/Not a git ref/)
    await expect(port.mergeBase(repo, 'main', '--all')).rejects.toThrow(/Not a git ref/)
    await expect(port.fetch(repo, ['--upload-pack=x'])).rejects.toThrow(/Not a git ref/)
  })

  it('logs commits after a ref, touching given paths, newest first', async () => {
    const { repo, first, port } = setup()
    expect((await port.log(repo, { since: first })).map((c) => c.message)).toEqual(['main moves'])
    expect((await port.log(repo, { paths: ['a.ts'] })).map((c) => c.message)).toEqual(['first'])
    const [latest] = await port.log(repo, { limit: 1 })
    expect(latest).toEqual({
      hash: git(repo, 'rev-parse', 'HEAD'),
      message: 'main moves',
      author: 'Alex',
      date: expect.any(String)
    })
  })

  it('releases checkouts a previous process left behind', async () => {
    const { repo, checkouts, port } = setup()
    const left = await port.checkout(repo, 'feature')
    const next = createSovereignGitPort(createGitCli(), checkouts)
    expect(await next.releaseLeftovers()).toBe(1)
    expect(fs.existsSync(left.path)).toBe(false)
    expect((await worktreeList(repo)).map((w) => w.worktree)).toEqual([repo])
    expect(await next.releaseLeftovers()).toBe(0)
  })
})

describe('mountGraphcoder', () => {
  const allow = (_req: unknown, _res: unknown, next: () => void) => next()
  const noRoots = { status: () => ({ enabled: true, roots: [] }) }

  it('mounts nothing when graphcoder is off', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-mount-')))
    const app = express()
    expect(
      mountGraphcoder(app, { enabled: false, codeIndex: noRoots, dataDir: tmp, requireAuth: allow })
    ).toBeUndefined()
    expect((await request(app).get('/api/graphcoder/status')).status).toBe(404)
  })

  const hasCodegraph = spawnSync('codegraph', ['--version']).status === 0
  it.skipIf(!hasCodegraph)(
    'serves the counts and change structures of a checkout the code index tracks when on',
    async () => {
      tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-mount-')))
      const repo = path.join(tmp, 'org', 'app')
      fs.mkdirSync(repo, { recursive: true })
      fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() { return 1 }\nexport class Beta {}\n')
      git(repo, 'init', '-q', '-b', 'main')
      git(repo, 'add', 'a.ts')
      git(repo, 'commit', '-qm', 'first')
      git(repo, 'checkout', '-qb', 'feature')
      fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() { return 2 }\nexport class Beta {}\n')
      git(repo, 'commit', '-qam', 'alpha returns 2')
      git(repo, 'checkout', '-q', 'main')
      execFileSync('codegraph', ['init', repo], { stdio: 'ignore' })
      const app = express()
      const codeIndex = { status: () => ({ enabled: true, roots: [{ root: repo, state: 'ok' as const }] }) }
      const dataDir = path.join(tmp, 'data')
      const structureOf = mountGraphcoder(app, { enabled: true, codeIndex, dataDir, requireAuth: allow })
      expect(structureOf).toBeTypeOf('function')
      expect((await request(app).get('/api/graphcoder/status')).body).toEqual({ enabled: true, repos: [repo] })
      const stats = await request(app).get('/api/graphcoder/repos/stats').query({ path: repo })
      expect(stats.status).toBe(200)
      expect(stats.body).toMatchObject({
        path: repo,
        fileCount: 1,
        nodesByKind: { function: 1, class: 1 },
        annotations: 0
      })
      expect(stats.body.nodeCount).toBeGreaterThanOrEqual(3)
      expect((await request(app).get('/api/graphcoder/repos/stats').query({ path: tmp })).status).toBe(404)

      const structure = await structureOf!(repo, 'main', 'feature')
      expect(structure.symbols.modified.map((s) => s.name)).toEqual(['alpha'])
      expect(structure.modules).toEqual([{ module: '.', label: '.', added: 0, removed: 0, modified: 1 }])
      const cached = await request(app)
        .get('/api/graphcoder/structure/cached')
        .query({ path: repo, base: 'main', head: 'feature' })
      expect(cached.body).toEqual({ state: 'ready', structure })
      expect(fs.readdirSync(path.join(dataDir, 'graphcoder', 'structure'))).toHaveLength(1)

      const concepts = await request(app).get('/api/graphcoder/concepts').query({ path: repo, ref: 'feature' })
      expect(concepts.status).toBe(200)
      expect(concepts.body).toMatchObject({ path: repo, dir: 'mental-models', pages: [], coverage: { files: 1 } })
      expect(fs.readdirSync(path.join(dataDir, 'graphcoder', 'concepts'))).toHaveLength(1)
      expect(fs.readdirSync(path.join(dataDir, 'graphcoder', 'checkouts'))).toEqual([])
      expect((await worktreeList(repo)).map((w) => w.worktree)).toEqual([repo])
    }
  )
})

describe('code-index GraphSource', () => {
  it('lists only tracked checkouts that have an index, and opens nothing else', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-source-')))
    const indexed = path.join(tmp, 'indexed')
    const pending = path.join(tmp, 'pending')
    fs.mkdirSync(path.join(indexed, '.codegraph'), { recursive: true })
    fs.writeFileSync(path.join(indexed, '.codegraph', 'codegraph.db'), '')
    fs.mkdirSync(pending)
    const source = createCodeIndexGraphSource({
      status: () => ({
        enabled: true,
        roots: [
          { root: indexed, state: 'ok' },
          { root: pending, state: 'syncing' }
        ]
      })
    })
    expect(await source.list()).toEqual([indexed])
    await expect(source.open(pending)).rejects.toThrow(/Not an indexed checkout/)
    await expect(source.open('/etc')).rejects.toThrow(/Not an indexed checkout/)
  })

  const hasCodegraph = spawnSync('codegraph', ['--version']).status === 0
  it.skipIf(!hasCodegraph)('opens a tracked checkout read-only through the index reader', async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'graphcoder-source-')))
    const repo = path.join(tmp, 'app')
    fs.mkdirSync(repo)
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function alpha() { return 1 }\n')
    git(repo, 'init', '-q')
    execFileSync('codegraph', ['init', repo], { stdio: 'ignore' })
    const source = createCodeIndexGraphSource({
      status: () => ({ enabled: true, roots: [{ root: repo, state: 'ok' }] })
    })
    const handle = await source.open(repo)
    try {
      expect(handle.stats()).toMatchObject({ fileCount: 1, nodesByKind: { function: 1 } })
    } finally {
      handle.close()
    }
  })
})
