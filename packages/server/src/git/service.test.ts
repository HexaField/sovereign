import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import express from 'express'
import request from 'supertest'
import { createGitCli, type GitCli } from './git.js'
import { createGitService, type GitService, type ResolveProject } from './service.js'
import { createGitRoutes } from './routes.js'
import type { EventBus, BusEvent } from '@template/core'

const execFileAsync = promisify(execFile)

async function gitCmd(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'git-svc-test-'))
  await gitCmd(dir, ['init', '-b', 'main'])
  await gitCmd(dir, ['config', 'user.email', 'test@test.com'])
  await gitCmd(dir, ['config', 'user.name', 'Test User'])
  await writeFile(join(dir, 'README.md'), '# Test')
  await gitCmd(dir, ['add', '.'])
  await gitCmd(dir, ['commit', '-m', 'initial commit'])
  return dir
}

function createMockBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = []
  return {
    events,
    emit(event: BusEvent) {
      events.push(event)
    },
    on: () => () => {},
    once: () => () => {},
    replay: () => (async function* () {})(),
    history: () => []
  }
}

describe('Git Service', () => {
  let repoDir: string
  let worktreeDir: string
  let cli: GitCli
  let bus: ReturnType<typeof createMockBus>
  let service: GitService
  let resolveProject: ResolveProject

  beforeEach(async () => {
    repoDir = await initRepo()
    // Create a second dir to simulate worktree
    worktreeDir = await mkdtemp(join(tmpdir(), 'git-wt-test-'))
    await gitCmd(worktreeDir, ['init', '-b', 'feature'])
    await gitCmd(worktreeDir, ['config', 'user.email', 'test@test.com'])
    await gitCmd(worktreeDir, ['config', 'user.name', 'Test User'])
    await writeFile(join(worktreeDir, 'README.md'), '# WT')
    await gitCmd(worktreeDir, ['add', '.'])
    await gitCmd(worktreeDir, ['commit', '-m', 'wt initial'])

    cli = createGitCli()
    bus = createMockBus()
    resolveProject = (orgId: string, projectId: string, worktreeId?: string) => {
      if (orgId !== 'org1' || projectId !== 'proj1') {
        throw new Error(`Unknown project: ${orgId}/${projectId}`)
      }
      return {
        repoPath: worktreeId === 'wt1' ? worktreeDir : repoDir,
        defaultBranch: 'main'
      }
    }
    service = createGitService(bus, cli, resolveProject)
  })

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true })
    await rm(worktreeDir, { recursive: true, force: true })
  })

  // Validation
  it('validates orgId and projectId before operations', async () => {
    await expect(service.status('badorg', 'badproj')).rejects.toThrow('Unknown project')
  })

  it('scopes operations to correct worktree when worktreeId provided', async () => {
    const status = await service.status('org1', 'proj1', 'wt1')
    expect(status.branch).toBe('feature')

    const mainStatus = await service.status('org1', 'proj1')
    expect(mainStatus.branch).toBe('main')
  })

  it('rejects push to default/protected branch', async () => {
    await expect(service.push('org1', 'proj1')).rejects.toThrow('protected branch')
  })

  // Status
  it('returns git status for active project', async () => {
    const status = await service.status('org1', 'proj1')
    expect(status.branch).toBe('main')
    expect(status.staged).toEqual([])
    expect(status.modified).toEqual([])
    expect(status.untracked).toEqual([])
  })

  it('returns git status for specific worktree', async () => {
    const status = await service.status('org1', 'proj1', 'wt1')
    expect(status.branch).toBe('feature')
  })

  // Staging
  it('stages individual files', async () => {
    await writeFile(join(repoDir, 'new.txt'), 'data')
    await service.stage('org1', 'proj1', ['new.txt'])
    const status = await service.status('org1', 'proj1')
    expect(status.staged.some((f) => f.path === 'new.txt')).toBe(true)
  })

  it('stages all files', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'a')
    await writeFile(join(repoDir, 'b.txt'), 'b')
    await service.stage('org1', 'proj1', ['.'])
    const status = await service.status('org1', 'proj1')
    expect(status.staged.length).toBe(2)
  })

  it('unstages individual files', async () => {
    await writeFile(join(repoDir, 'new.txt'), 'data')
    await gitCmd(repoDir, ['add', 'new.txt'])
    await service.unstage('org1', 'proj1', ['new.txt'])
    const status = await service.status('org1', 'proj1')
    expect(status.staged.some((f) => f.path === 'new.txt')).toBe(false)
  })

  it('unstages all files', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'a')
    await writeFile(join(repoDir, 'b.txt'), 'b')
    await gitCmd(repoDir, ['add', '.'])
    await service.unstage('org1', 'proj1', ['.'])
    const status = await service.status('org1', 'proj1')
    expect(status.staged.length).toBe(0)
  })

  // Commits
  it('creates a commit and returns CommitInfo', async () => {
    await writeFile(join(repoDir, 'file.txt'), 'content')
    await gitCmd(repoDir, ['add', '.'])
    const info = await service.commit('org1', 'proj1', 'service commit')
    expect(info.hash).toHaveLength(40)
    expect(info.message).toBe('service commit')
  })

  it('rejects commit with empty message', async () => {
    await expect(service.commit('org1', 'proj1', '')).rejects.toThrow('empty')
    await expect(service.commit('org1', 'proj1', '  ')).rejects.toThrow('empty')
  })

  // Push/Pull
  it('pushes to remote', async () => {
    // Set up remote and feature branch
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'main'])
    await gitCmd(repoDir, ['checkout', '-b', 'feature-push'])
    await writeFile(join(repoDir, 'push.txt'), 'data')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'push commit'])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'feature-push'])

    // Now push via service (on feature branch, not default)
    await writeFile(join(repoDir, 'push2.txt'), 'data2')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'push2'])
    await service.push('org1', 'proj1')

    await rm(remoteDir, { recursive: true, force: true })
  })

  it('pulls from remote', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'main'])
    await gitCmd(repoDir, ['checkout', '-b', 'feat'])
    await writeFile(join(repoDir, 'f.txt'), 'x')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'feat commit'])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'feat'])

    // Pull should work
    await service.pull('org1', 'proj1')

    await rm(remoteDir, { recursive: true, force: true })
  })

  // Branches
  it('lists branches for a project', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'dev'])
    await gitCmd(repoDir, ['checkout', 'main'])
    const branches = await service.branches('org1', 'proj1')
    expect(branches).toContain('main')
    expect(branches).toContain('dev')
  })

  it('creates and switches to a new branch', async () => {
    await service.checkout('org1', 'proj1', 'new-feat', true)
    const status = await service.status('org1', 'proj1')
    expect(status.branch).toBe('new-feat')
  })

  it('switches to existing branch', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'existing'])
    await gitCmd(repoDir, ['checkout', 'main'])
    await service.checkout('org1', 'proj1', 'existing')
    const status = await service.status('org1', 'proj1')
    expect(status.branch).toBe('existing')
  })

  // Log
  it('returns commit log with limit', async () => {
    await writeFile(join(repoDir, 'a.txt'), 'a')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'second'])
    const log = await service.log('org1', 'proj1', 1)
    expect(log).toHaveLength(1)
    expect(log[0].message).toBe('second')
  })

  // Diff
  it('returns diff for a modified file', async () => {
    await writeFile(join(repoDir, 'README.md'), '# Changed')
    const diff = await service.diff('org1', 'proj1', 'README.md')
    expect(diff).toContain('Changed')
  })

  // Events
  it('emits git.commit on the bus', async () => {
    await writeFile(join(repoDir, 'f.txt'), 'x')
    await gitCmd(repoDir, ['add', '.'])
    await service.commit('org1', 'proj1', 'bus commit')
    const commitEvents = bus.events.filter((e) => e.type === 'git.commit')
    expect(commitEvents).toHaveLength(1)
    expect((commitEvents[0].payload as { commit: { message: string } }).commit.message).toBe('bus commit')
  })

  it('emits git.push on the bus', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'main'])
    await gitCmd(repoDir, ['checkout', '-b', 'push-evt'])
    await writeFile(join(repoDir, 'x.txt'), 'x')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'x'])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'push-evt'])

    await writeFile(join(repoDir, 'y.txt'), 'y')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'y'])
    await service.push('org1', 'proj1')

    expect(bus.events.some((e) => e.type === 'git.push')).toBe(true)
    await rm(remoteDir, { recursive: true, force: true })
  })

  it('emits git.pull on the bus', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['checkout', '-b', 'pull-evt'])
    await writeFile(join(repoDir, 'z.txt'), 'z')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'z'])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'pull-evt'])

    await service.pull('org1', 'proj1')
    expect(bus.events.some((e) => e.type === 'git.pull')).toBe(true)
    await rm(remoteDir, { recursive: true, force: true })
  })

  it('emits git.branch.created on the bus', async () => {
    await service.checkout('org1', 'proj1', 'created-branch', true)
    expect(bus.events.some((e) => e.type === 'git.branch.created')).toBe(true)
  })

  it('emits git.branch.switched on the bus', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'sw-branch'])
    await gitCmd(repoDir, ['checkout', 'main'])
    await service.checkout('org1', 'proj1', 'sw-branch')
    expect(bus.events.some((e) => e.type === 'git.branch.switched')).toBe(true)
  })
})

describe('Git Routes', () => {
  let repoDir: string
  let app: ReturnType<typeof express>
  let bus: ReturnType<typeof createMockBus>

  beforeEach(async () => {
    repoDir = await initRepo()
    bus = createMockBus()
    const cli = createGitCli()
    const resolveProject: ResolveProject = (orgId, projectId) => {
      if (orgId !== 'org1' || projectId !== 'proj1') throw new Error('Unknown project')
      return { repoPath: repoDir, defaultBranch: 'main' }
    }
    const service = createGitService(bus, cli, resolveProject)

    app = express()
    app.use(express.json())

    // Auth middleware that checks for Bearer token
    const authMiddleware = (req: express.Request, res: express.Response, next: () => void) => {
      const auth = req.headers.authorization
      if (!auth || !auth.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      next()
    }

    app.use('/api/git', createGitRoutes(service, authMiddleware))
  })

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true })
  })

  const auth = { Authorization: 'Bearer test-token' }

  it('GET /api/git/status returns git status', async () => {
    const res = await request(app).get('/api/git/status').query({ orgId: 'org1', projectId: 'proj1' }).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.branch).toBe('main')
  })

  it('POST /api/git/stage stages files', async () => {
    await writeFile(join(repoDir, 'new.txt'), 'data')
    const res = await request(app)
      .post('/api/git/stage')
      .set(auth)
      .send({ orgId: 'org1', projectId: 'proj1', paths: ['new.txt'] })
    expect(res.status).toBe(200)
  })

  it('POST /api/git/unstage unstages files', async () => {
    await writeFile(join(repoDir, 'new.txt'), 'data')
    await gitCmd(repoDir, ['add', 'new.txt'])
    const res = await request(app)
      .post('/api/git/unstage')
      .set(auth)
      .send({ orgId: 'org1', projectId: 'proj1', paths: ['new.txt'] })
    expect(res.status).toBe(200)
  })

  it('POST /api/git/commit creates commit', async () => {
    await writeFile(join(repoDir, 'c.txt'), 'c')
    await gitCmd(repoDir, ['add', '.'])
    const res = await request(app)
      .post('/api/git/commit')
      .set(auth)
      .send({ orgId: 'org1', projectId: 'proj1', message: 'route commit' })
    expect(res.status).toBe(200)
    expect(res.body.message).toBe('route commit')
  })

  it('POST /api/git/push pushes to remote', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'main'])
    await gitCmd(repoDir, ['checkout', '-b', 'push-route'])
    await writeFile(join(repoDir, 'p.txt'), 'p')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'p'])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'push-route'])

    await writeFile(join(repoDir, 'q.txt'), 'q')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'q'])

    const res = await request(app).post('/api/git/push').set(auth).send({ orgId: 'org1', projectId: 'proj1' })
    expect(res.status).toBe(200)

    await rm(remoteDir, { recursive: true, force: true })
  })

  it('POST /api/git/pull pulls from remote', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'git-remote-'))
    await gitCmd(remoteDir, ['init', '--bare'])
    await gitCmd(repoDir, ['remote', 'add', 'origin', remoteDir])
    await gitCmd(repoDir, ['checkout', '-b', 'pull-route'])
    await writeFile(join(repoDir, 'pr.txt'), 'pr')
    await gitCmd(repoDir, ['add', '.'])
    await gitCmd(repoDir, ['commit', '-m', 'pr'])
    await gitCmd(repoDir, ['push', '-u', 'origin', 'pull-route'])

    const res = await request(app).post('/api/git/pull').set(auth).send({ orgId: 'org1', projectId: 'proj1' })
    expect(res.status).toBe(200)

    await rm(remoteDir, { recursive: true, force: true })
  })

  it('GET /api/git/branches lists branches', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'feat'])
    await gitCmd(repoDir, ['checkout', 'main'])
    const res = await request(app).get('/api/git/branches').query({ orgId: 'org1', projectId: 'proj1' }).set(auth)
    expect(res.status).toBe(200)
    expect(res.body).toContain('main')
    expect(res.body).toContain('feat')
  })

  it('POST /api/git/checkout switches branch', async () => {
    await gitCmd(repoDir, ['checkout', '-b', 'sw'])
    await gitCmd(repoDir, ['checkout', 'main'])
    const res = await request(app)
      .post('/api/git/checkout')
      .set(auth)
      .send({ orgId: 'org1', projectId: 'proj1', branch: 'sw' })
    expect(res.status).toBe(200)
  })

  it('GET /api/git/log returns commit log', async () => {
    const res = await request(app).get('/api/git/log').query({ orgId: 'org1', projectId: 'proj1' }).set(auth)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(0)
  })

  it('rejects push to protected branch with 403', async () => {
    const res = await request(app).post('/api/git/push').set(auth).send({ orgId: 'org1', projectId: 'proj1' })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('protected branch')
  })

  it('all routes reject unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/git/status').query({ orgId: 'org1', projectId: 'proj1' })
    expect(res.status).toBe(401)
  })
})
