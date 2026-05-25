import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectMonorepo } from './monorepo.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-mono-test-'))
}

let dirs: string[] = []

function makeRepo(): string {
  const d = tmpDir()
  dirs.push(d)
  fs.mkdirSync(path.join(d, '.git'))
  return d
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
  dirs = []
})

describe('Monorepo Detection', () => {
  it('detects pnpm-workspace.yaml and lists packages', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    const pkgDir = path.join(repo, 'packages', 'alpha')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}')
    const result = detectMonorepo(repo)
    expect(result?.tool).toBe('pnpm')
    expect(result?.packages).toContain('packages/alpha')
  })

  it('detects package.json workspaces field and lists packages', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    const pkgDir = path.join(repo, 'packages', 'beta')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}')
    const result = detectMonorepo(repo)
    expect(result?.tool).toBe('npm')
    expect(result?.packages).toContain('packages/beta')
  })

  it('detects nx.json', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'nx.json'), '{}')
    const result = detectMonorepo(repo)
    expect(result?.tool).toBe('nx')
  })

  it('detects turbo.json', () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'turbo.json'), '{}')
    const result = detectMonorepo(repo)
    expect(result?.tool).toBe('turborepo')
  })

  it('returns null for non-monorepo directory', () => {
    const repo = makeRepo()
    expect(detectMonorepo(repo)).toBeNull()
  })
})
