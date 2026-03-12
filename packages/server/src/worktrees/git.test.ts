import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { worktreeAdd, worktreeRemove, worktreeList, isBranchMerged, deleteBranch, getLastCommitDate } from './git.js'

let tmpDir: string
let repoPath: string

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'repo-'))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@test.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'commit', '--allow-empty', '-m', 'init')
  return dir
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'))
  repoPath = initRepo()
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Worktree Git Wrapper', () => {
  it('executes git worktree add with correct branch', async () => {
    const wtPath = path.join(tmpDir, 'wt-feat')
    await worktreeAdd(repoPath, wtPath, 'feat-1', 'main')
    expect(fs.existsSync(wtPath)).toBe(true)
    const branch = git(wtPath, 'branch', '--show-current')
    expect(branch).toBe('feat-1')
  })

  it('executes git worktree remove', async () => {
    const wtPath = path.join(tmpDir, 'wt-remove')
    await worktreeAdd(repoPath, wtPath, 'feat-remove', 'main')
    expect(fs.existsSync(wtPath)).toBe(true)
    await worktreeRemove(repoPath, wtPath)
    expect(fs.existsSync(wtPath)).toBe(false)
  })

  it('lists worktrees via git worktree list --porcelain', async () => {
    const wtPath = path.join(tmpDir, 'wt-list')
    await worktreeAdd(repoPath, wtPath, 'feat-list', 'main')
    const entries = await worktreeList(repoPath)
    expect(entries.length).toBeGreaterThanOrEqual(2)
    const wt = entries.find((e) => e.branch?.endsWith('feat-list'))
    expect(wt).toBeDefined()
    expect(fs.realpathSync(wt!.worktree)).toBe(fs.realpathSync(wtPath))
  })

  it('detects if branch is merged into target', async () => {
    // feat-merged is created from main with no extra commits, so it's merged
    const wtPath = path.join(tmpDir, 'wt-merged')
    await worktreeAdd(repoPath, wtPath, 'feat-merged', 'main')
    await worktreeRemove(repoPath, wtPath)
    const merged = await isBranchMerged(repoPath, 'feat-merged', 'main')
    expect(merged).toBe(true)
  })

  it('deletes branch after confirming merge', async () => {
    const wtPath = path.join(tmpDir, 'wt-del')
    await worktreeAdd(repoPath, wtPath, 'feat-del', 'main')
    await worktreeRemove(repoPath, wtPath)
    await deleteBranch(repoPath, 'feat-del')
    const branches = git(repoPath, 'branch')
      .split('\n')
      .map((b) => b.trim().replace(/^\* /, ''))
    expect(branches).not.toContain('feat-del')
  })

  it('gets last commit date for a worktree', async () => {
    const wtPath = path.join(tmpDir, 'wt-date')
    await worktreeAdd(repoPath, wtPath, 'feat-date', 'main')
    const date = await getLastCommitDate(wtPath)
    expect(date).toBeDefined()
    expect(new Date(date!).getTime()).toBeGreaterThan(0)
  })
})
