import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createThreadGitRoutes, type ThreadRepoResolver } from './thread-routes.js'
import type { GitCli } from './git.js'

// Minimal GitCli mock
function mockGitCli(overrides: Partial<GitCli> = {}): GitCli {
  return {
    status: vi.fn().mockResolvedValue({
      branch: 'feat-branch',
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: []
    }),
    stage: vi.fn(),
    unstage: vi.fn(),
    commit: vi.fn(),
    push: vi.fn(),
    pull: vi.fn(),
    branches: vi.fn().mockResolvedValue(['main', 'feat-branch']),
    checkout: vi.fn(),
    log: vi.fn().mockResolvedValue([]),
    diff: vi.fn().mockResolvedValue(''),
    repoRoot: vi.fn().mockResolvedValue('/home/user/project'),
    defaultBranch: vi.fn().mockResolvedValue('main'),
    mergeBase: vi.fn().mockResolvedValue('abc123'),
    branchDiffStat: vi.fn().mockResolvedValue([
      { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 3 },
      { path: 'src/b.ts', status: 'added', additions: 25, deletions: 0 }
    ]),
    branchDiff: vi.fn().mockResolvedValue('diff --git a/src/a.ts b/src/a.ts\n...'),
    remoteUrl: vi.fn().mockResolvedValue('git@github.com:hexafield/sovereign.git'),
    aheadCount: vi.fn().mockResolvedValue(5),
    commitDiff: vi.fn().mockResolvedValue(''),
    branchCommits: vi.fn().mockResolvedValue([]),
    uncommittedDiff: vi.fn().mockResolvedValue(''),
    ...overrides
  }
}

function makeApp(gitCli: GitCli, resolveRepos: ThreadRepoResolver) {
  const app = express()
  app.use(createThreadGitRoutes(gitCli, resolveRepos))
  return app
}

describe('GET /api/threads/:threadId/git-context', () => {
  it('returns empty contexts when thread has no repos', async () => {
    const app = makeApp(mockGitCli(), () => [])
    const res = await request(app).get('/api/threads/t1/git-context')
    expect(res.status).toBe(200)
    expect(res.body.contexts).toEqual([])
  })

  it('returns git context for a feature branch', async () => {
    const app = makeApp(mockGitCli(), () => ['/home/user/project'])
    const res = await request(app).get('/api/threads/t1/git-context')
    expect(res.status).toBe(200)
    expect(res.body.contexts).toHaveLength(1)

    const ctx = res.body.contexts[0]
    expect(ctx.repoRoot).toBe('/home/user/project')
    expect(ctx.repoName).toBe('project')
    expect(ctx.branch).toBe('feat-branch')
    expect(ctx.baseBranch).toBe('main')
    expect(ctx.aheadBy).toBe(5)
    expect(ctx.files).toHaveLength(2)
    expect(ctx.remote).toEqual({
      url: 'https://github.com/hexafield/sovereign',
      owner: 'hexafield',
      repo: 'sovereign'
    })
  })

  it('returns working-tree changes when on default branch', async () => {
    const cli = mockGitCli({
      status: vi.fn().mockResolvedValue({
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [{ path: 'staged.ts', status: 'added' }],
        modified: [{ path: 'mod.ts', status: 'modified' }],
        untracked: []
      })
    })
    const app = makeApp(cli, () => ['/home/user/project'])
    const res = await request(app).get('/api/threads/t1/git-context')

    const ctx = res.body.contexts[0]
    expect(ctx.branch).toBe('main')
    expect(ctx.files).toHaveLength(2)
    expect(ctx.files.map((f: any) => f.path).sort()).toEqual(['mod.ts', 'staged.ts'])
  })

  it('returns contexts for multiple repos', async () => {
    const app = makeApp(mockGitCli(), () => ['/home/user/repo-a', '/home/user/repo-b'])
    const res = await request(app).get('/api/threads/t1/git-context')
    expect(res.status).toBe(200)
    expect(res.body.contexts).toHaveLength(2)
    expect(res.body.contexts[0].repoRoot).toBe('/home/user/repo-a')
    expect(res.body.contexts[1].repoRoot).toBe('/home/user/repo-b')
  })

  it('parses HTTPS remote URLs', async () => {
    const cli = mockGitCli({
      remoteUrl: vi.fn().mockResolvedValue('https://github.com/owner/repo.git')
    })
    const app = makeApp(cli, () => ['/home/user/project'])
    const res = await request(app).get('/api/threads/t1/git-context')

    expect(res.body.contexts[0].remote).toEqual({
      url: 'https://github.com/owner/repo',
      owner: 'owner',
      repo: 'repo'
    })
  })

  it('handles missing remote gracefully', async () => {
    const cli = mockGitCli({ remoteUrl: vi.fn().mockResolvedValue(null) })
    const app = makeApp(cli, () => ['/home/user/project'])
    const res = await request(app).get('/api/threads/t1/git-context')

    expect(res.body.contexts[0].remote).toBeUndefined()
  })

  it('skips repos that error and returns the rest', async () => {
    let callCount = 0
    const cli = mockGitCli({
      status: vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) throw new Error('permission denied')
        return Promise.resolve({
          branch: 'feat-branch',
          ahead: 0,
          behind: 0,
          staged: [],
          modified: [],
          untracked: []
        })
      })
    })
    const app = makeApp(cli, () => ['/bad-repo', '/good-repo'])
    const res = await request(app).get('/api/threads/t1/git-context')
    expect(res.status).toBe(200)
    // First repo errored → null → filtered out; second repo succeeds
    expect(res.body.contexts).toHaveLength(1)
    expect(res.body.contexts[0].repoRoot).toBe('/good-repo')
  })
})

describe('GET /api/threads/:threadId/diff', () => {
  it('returns 404 when thread has no repos', async () => {
    const app = makeApp(mockGitCli(), () => [])
    const res = await request(app).get('/api/threads/t1/diff')
    expect(res.status).toBe(404)
  })

  it('returns branch diff for a feature branch', async () => {
    const diffText = 'diff --git a/a.ts b/a.ts\n+added line'
    const cli = mockGitCli({ branchDiff: vi.fn().mockResolvedValue(diffText) })
    const app = makeApp(cli, () => ['/home/user/project'])
    const res = await request(app).get('/api/threads/t1/diff?repo=/home/user/project')
    expect(res.status).toBe(200)
    expect(res.body.diff).toBe(diffText)
  })

  it('returns file-scoped diff when file param given', async () => {
    const cli = mockGitCli({
      branchDiff: vi.fn().mockResolvedValue('single file diff')
    })
    const app = makeApp(cli, () => ['/home/user/project'])
    const res = await request(app).get('/api/threads/t1/diff?repo=/home/user/project&file=src/a.ts')
    expect(res.status).toBe(200)
    expect(cli.branchDiff).toHaveBeenCalledWith('/home/user/project', 'abc123', 'src/a.ts')
  })

  it('falls back to first repo when no repo param given', async () => {
    const cli = mockGitCli({
      branchDiff: vi.fn().mockResolvedValue('first repo diff')
    })
    const app = makeApp(cli, () => ['/repo-a', '/repo-b'])
    const res = await request(app).get('/api/threads/t1/diff')
    expect(res.status).toBe(200)
    expect(cli.branchDiff).toHaveBeenCalledWith('/repo-a', 'abc123', undefined)
  })

  it('returns uncommitted diff when commit=uncommitted', async () => {
    const uncommittedText = 'diff --git a/wip.ts b/wip.ts\n+work in progress'
    const cli = mockGitCli({
      uncommittedDiff: vi.fn().mockResolvedValue(uncommittedText)
    })
    const app = makeApp(cli, () => ['/home/user/project'])

    const res = await request(app).get('/api/threads/t1/diff?repo=/home/user/project&commit=uncommitted')
    expect(res.status).toBe(200)
    expect(res.body.diff).toBe(uncommittedText)
    expect(cli.uncommittedDiff).toHaveBeenCalledWith('/home/user/project', undefined)
    // Should NOT call commitDiff or branchDiff
    expect(cli.commitDiff).not.toHaveBeenCalled()
    expect(cli.branchDiff).not.toHaveBeenCalled()
  })

  it('returns uncommitted file diff when commit=uncommitted with file', async () => {
    const cli = mockGitCli({
      uncommittedDiff: vi.fn().mockResolvedValue('uncommitted file diff')
    })
    const app = makeApp(cli, () => ['/home/user/project'])

    const res = await request(app).get(
      '/api/threads/t1/diff?repo=/home/user/project&commit=uncommitted&file=src/wip.ts'
    )
    expect(res.status).toBe(200)
    expect(cli.uncommittedDiff).toHaveBeenCalledWith('/home/user/project', 'src/wip.ts')
  })

  it('returns commit-scoped diff when commit param given', async () => {
    const commitDiffText = 'diff --git a/file.ts b/file.ts\n+commit change'
    const cli = mockGitCli({
      commitDiff: vi.fn().mockResolvedValue(commitDiffText)
    })
    const app = makeApp(cli, () => ['/home/user/project'])

    // Commit diff — full
    const res = await request(app).get('/api/threads/t1/diff?repo=/home/user/project&commit=abc1234')
    expect(res.status).toBe(200)
    expect(res.body.diff).toBe(commitDiffText)
    expect(cli.commitDiff).toHaveBeenCalledWith('/home/user/project', 'abc1234', undefined)
  })

  it('returns commit-scoped file diff when commit + file params given', async () => {
    const cli = mockGitCli({
      commitDiff: vi.fn().mockResolvedValue('commit file diff')
    })
    const app = makeApp(cli, () => ['/home/user/project'])

    const res = await request(app).get('/api/threads/t1/diff?repo=/home/user/project&commit=abc1234&file=src/a.ts')
    expect(res.status).toBe(200)
    expect(cli.commitDiff).toHaveBeenCalledWith('/home/user/project', 'abc1234', 'src/a.ts')
    // Should NOT call branchDiff — commit param short-circuits
    expect(cli.branchDiff).not.toHaveBeenCalled()
  })

  it('falls back to working-tree diff on default branch', async () => {
    const cli = mockGitCli({
      status: vi.fn().mockResolvedValue({
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        untracked: []
      }),
      branchDiff: vi.fn().mockResolvedValue('working tree diff'),
      diff: vi.fn().mockResolvedValue('file diff')
    })
    const app = makeApp(cli, () => ['/home/user/project'])

    // Full diff on default branch
    const res = await request(app).get('/api/threads/t1/diff?repo=/home/user/project')
    expect(res.status).toBe(200)
    expect(cli.branchDiff).toHaveBeenCalledWith('/home/user/project')

    // File-specific diff on default branch
    const res2 = await request(app).get('/api/threads/t1/diff?repo=/home/user/project&file=x.ts')
    expect(res2.status).toBe(200)
    expect(cli.diff).toHaveBeenCalledWith('/home/user/project', 'x.ts')
  })
})
