import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitConfigPath, parseForgeRemotes, parseGitRemotes, splitRemoteUrl } from './remotes.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remotes-test-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alex',
      GIT_AUTHOR_EMAIL: 'alex@example.org',
      GIT_COMMITTER_NAME: 'Alex',
      GIT_COMMITTER_EMAIL: 'alex@example.org'
    }
  })

function writeConfig(dir: string, body: string) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.git', 'config'), body)
}

const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = git@github.com:acme-labs/widget.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "fork"]
\turl = https://github.com/kit-bot/widget.js
\tfetch = +refs/heads/*:refs/remotes/fork/*
[remote "rad"]
\turl = rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5
[remote "gitea"]
\turl = ssh://git@git.example.org:2222/acme/tools.git
[remote "lab"]
\turl = https://gitlab.example.org/acme/sub/group/thing.git
[remote "local"]
\turl = /srv/mirrors/widget.git
[branch "dev"]
\tremote = origin
`

describe('splitRemoteUrl', () => {
  it('splits scp-like, ssh://, https:// and git:// URLs', () => {
    expect(splitRemoteUrl('git@github.com:acme-labs/widget.git')).toEqual({
      host: 'github.com',
      path: 'acme-labs/widget.git'
    })
    expect(splitRemoteUrl('ssh://git@git.example.org:2222/acme/tools.git')).toEqual({
      host: 'git.example.org',
      path: 'acme/tools.git'
    })
    expect(splitRemoteUrl('https://user:pw@GitHub.com/acme-labs/widget/')).toEqual({
      host: 'github.com',
      path: 'acme-labs/widget/'
    })
    expect(splitRemoteUrl('git://github.com/acme-labs/widget')).toEqual({
      host: 'github.com',
      path: 'acme-labs/widget'
    })
    expect(splitRemoteUrl('/srv/mirrors/widget.git')).toBeUndefined()
    expect(splitRemoteUrl('../widget')).toBeUndefined()
  })
})

describe('parseGitRemotes (clone)', () => {
  it('keeps GitHub and Radicle remotes, as before', () => {
    writeConfig(tmp, CONFIG)
    expect(parseGitRemotes(tmp)).toEqual([
      {
        name: 'origin',
        provider: 'github',
        repo: 'acme-labs/widget',
        host: 'github.com',
        url: 'git@github.com:acme-labs/widget.git'
      },
      {
        name: 'fork',
        provider: 'github',
        repo: 'kit-bot/widget.js',
        host: 'github.com',
        url: 'https://github.com/kit-bot/widget.js'
      },
      {
        name: 'rad',
        provider: 'radicle',
        rid: 'z3gqcJUoA1n9HaHKufZs5FCSGazv5',
        host: 'radicle',
        url: 'rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5'
      }
    ])
  })

  it('reads the older rad: form', () => {
    writeConfig(tmp, '[remote "rad"]\n\turl = rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5\n')
    expect(parseGitRemotes(tmp)).toMatchObject([{ provider: 'radicle', rid: 'z3gqcJUoA1n9HaHKufZs5FCSGazv5' }])
  })

  it('maps a self-hosted GitHub host to github only when told', () => {
    writeConfig(tmp, '[remote "origin"]\n\turl = git@ghe.example.org:acme/widget.git\n')
    expect(parseGitRemotes(tmp)).toEqual([])
    expect(parseGitRemotes(tmp, { 'ghe.example.org': 'github' })).toEqual([
      {
        name: 'origin',
        provider: 'github',
        repo: 'acme/widget',
        host: 'ghe.example.org',
        url: 'git@ghe.example.org:acme/widget.git'
      }
    ])
  })

  it('returns nothing for a directory without git, or a broken .git file', () => {
    expect(parseGitRemotes(tmp)).toEqual([])
    fs.writeFileSync(path.join(tmp, '.git'), 'not a gitdir line\n')
    expect(parseGitRemotes(tmp)).toEqual([])
    expect(parseGitRemotes(path.join(tmp, 'missing'))).toEqual([])
  })
})

describe('parseForgeRemotes', () => {
  it('reports forge and host for every known forge; unknown hosts and local paths are skipped', () => {
    writeConfig(tmp, CONFIG)
    const hosts = { 'git.example.org': 'gitea', 'gitlab.example.org': 'gitlab' } as const
    expect(parseForgeRemotes(tmp, hosts).map((r) => [r.name, r.forge, r.host, r.repo])).toEqual([
      ['origin', 'github', 'github.com', 'acme-labs/widget'],
      ['fork', 'github', 'github.com', 'kit-bot/widget.js'],
      ['rad', 'radicle', 'radicle', 'z3gqcJUoA1n9HaHKufZs5FCSGazv5'],
      ['gitea', 'gitea', 'git.example.org', 'acme/tools'],
      ['lab', 'gitlab', 'gitlab.example.org', 'acme/sub/group/thing']
    ])
    expect(parseForgeRemotes(tmp).map((r) => r.name)).toEqual(['origin', 'fork', 'rad'])
  })

  it('treats ssh.github.com (SSH over 443) and www.github.com as github.com', () => {
    writeConfig(
      tmp,
      '[remote "a"]\n\turl = ssh://git@ssh.github.com:443/acme-labs/widget.git\n[remote "b"]\n\turl = https://www.github.com/acme-labs/gadget\n'
    )
    expect(parseForgeRemotes(tmp).map((r) => [r.host, r.repo])).toEqual([
      ['github.com', 'acme-labs/widget'],
      ['github.com', 'acme-labs/gadget']
    ])
  })
})

describe('worktrees', () => {
  it('reads the main repo config from a linked worktree (git worktree add)', () => {
    const main = path.join(tmp, 'main')
    fs.mkdirSync(main)
    git(main, 'init', '-q', '-b', 'dev')
    git(main, 'remote', 'add', 'origin', 'git@github.com:acme-labs/widget.git')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init')
    const wt = path.join(tmp, 'widget-feature')
    git(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt)

    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true)
    expect(fs.realpathSync(gitConfigPath(wt)!)).toBe(fs.realpathSync(path.join(main, '.git', 'config')))
    expect(parseGitRemotes(wt)).toEqual(parseGitRemotes(main))
    expect(parseGitRemotes(wt)).toMatchObject([{ name: 'origin', provider: 'github', repo: 'acme-labs/widget' }])
  })

  it('follows a relative gitdir and commondir', () => {
    // <tmp>/repo/.git is the common dir; the worktree's .git file points at .git/worktrees/w.
    writeConfig(path.join(tmp, 'repo'), '[remote "origin"]\n\turl = https://github.com/acme-labs/gadget.git\n')
    const admin = path.join(tmp, 'repo', '.git', 'worktrees', 'w')
    fs.mkdirSync(admin, { recursive: true })
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
    const wt = path.join(tmp, 'w')
    fs.mkdirSync(wt)
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/w\n')
    expect(parseGitRemotes(wt)).toMatchObject([{ name: 'origin', repo: 'acme-labs/gadget' }])
  })

  it('reads a submodule-style .git file without commondir', () => {
    const modules = path.join(tmp, 'super', '.git', 'modules', 'lib')
    fs.mkdirSync(modules, { recursive: true })
    fs.writeFileSync(path.join(modules, 'config'), '[remote "origin"]\n\turl = git@github.com:acme-labs/lib.git\n')
    const sub = path.join(tmp, 'super', 'lib')
    fs.mkdirSync(sub)
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${modules}\n`)
    expect(parseGitRemotes(sub)).toMatchObject([{ repo: 'acme-labs/lib' }])
  })
})
