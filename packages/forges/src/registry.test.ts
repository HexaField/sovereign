import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Forge } from '@sovereign/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discoverRepos, primaryRepo, repoKey } from './discovery.js'
import type { GithubForge } from './github.js'
import { createForgeRegistry } from './registry.js'

describe('createForgeRegistry', () => {
  const github = { token: 'x' }

  it('builds one GitHub adapter per host and reuses it', () => {
    const reg = createForgeRegistry({ github })
    const a = reg.forgeFor('github.com') as GithubForge
    expect(a.kind).toBe('github')
    expect(a.host).toBe('github.com')
    expect(a.transport.apiUrl).toBe('https://api.github.com')
    expect(reg.forgeFor({ forge: 'github', host: 'GitHub.com' })).toBe(a)
  })

  it('points a configured GitHub Enterprise host at its /api/v3 base', () => {
    const reg = createForgeRegistry({ github, hosts: { 'ghe.example.org': 'github' } })
    const f = reg.forgeFor('ghe.example.org') as GithubForge
    expect(f.host).toBe('ghe.example.org')
    expect(f.transport.apiUrl).toBe('https://ghe.example.org/api/v3')
    expect(f.transport.graphqlUrl).toBe('https://ghe.example.org/api/graphql')
  })

  it('takes per-host GitHub options (the wind tunnel points github.com at its mock)', () => {
    const reg = createForgeRegistry({ github, githubHosts: { 'github.com': { apiUrl: 'http://mock-github:8910' } } })
    const f = reg.forgeFor('github.com') as GithubForge
    expect(f.transport.apiUrl).toBe('http://mock-github:8910')
    expect(f.host).toBe('github.com')
  })

  it('has no adapter for unknown hosts or forges without a factory', () => {
    const reg = createForgeRegistry({ github, hosts: { 'git.example.org': 'gitea' } })
    expect(reg.forgeFor('unknown.example.org')).toBeUndefined()
    expect(reg.kindOf('git.example.org')).toBe('gitea')
    expect(reg.forgeFor('git.example.org')).toBeUndefined()
    expect(reg.forgeFor({ forge: 'radicle', host: 'radicle' })).toBeUndefined()
  })

  it('uses factories for other forges and registered adapters', () => {
    const fake = (host: string): Forge => ({ kind: 'gitea', host }) as Forge
    const reg = createForgeRegistry({ hosts: { 'git.example.org': 'gitea' }, factories: { gitea: fake } })
    expect(reg.forgeFor('git.example.org')).toMatchObject({ kind: 'gitea', host: 'git.example.org' })
    const mine = { kind: 'radicle', host: 'radicle' } as Forge
    reg.register(mine)
    expect(reg.forgeFor({ forge: 'radicle', host: 'radicle' })).toBe(mine)
    expect(reg.forgeFor('radicle')).toBe(mine)
  })
})

describe('discoverRepos', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forges-discover-'))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  const checkout = (name: string, remotes: Record<string, string>) => {
    const dir = path.join(tmp, name)
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.git', 'config'),
      Object.entries(remotes)
        .map(([n, url]) => `[remote "${n}"]\n\turl = ${url}\n`)
        .join('')
    )
    return dir
  }

  it('dedupes one repo across checkouts and remotes, origin first', () => {
    const a = checkout('widget', {
      upstream: 'git@github.com:acme-labs/gadget.git',
      origin: 'git@github.com:acme-labs/widget.git'
    })
    const b = checkout('widget-2', { origin: 'https://github.com/acme-labs/widget' })
    const c = checkout('notes', {})
    const repos = discoverRepos([a, b, c])
    expect(repos.map(repoKey)).toEqual(['github:github.com/acme-labs/widget', 'github:github.com/acme-labs/gadget'])
    expect(repos[0].checkouts).toEqual([
      { path: a, remote: 'origin' },
      { path: b, remote: 'origin' }
    ])
    expect(discoverRepos([a, a])[0].checkouts).toHaveLength(1)
  })

  it('includes self-hosted forges from the host map', () => {
    const a = checkout('tools', { origin: 'ssh://git@git.example.org/acme/tools.git' })
    expect(discoverRepos([a])).toEqual([])
    expect(discoverRepos([a], { 'git.example.org': 'gitea' }).map(repoKey)).toEqual([
      'gitea:git.example.org/acme/tools'
    ])
  })

  it('primaryRepo prefers origin', () => {
    const a = checkout('w', {
      fork: 'git@github.com:kit-bot/widget.git',
      origin: 'git@github.com:acme-labs/widget.git'
    })
    expect(primaryRepo(a)).toEqual({ forge: 'github', host: 'github.com', repo: 'acme-labs/widget' })
    expect(primaryRepo(checkout('x', { fork: 'git@github.com:kit-bot/widget.git' }))?.repo).toBe('kit-bot/widget')
    expect(primaryRepo(checkout('y', {}))).toBeUndefined()
  })
})
