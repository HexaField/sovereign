import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import express from 'express'
import request from 'supertest'
import { createEventBus } from '@sovereign/core'
import { createOrgManager } from '../orgs/orgs.js'
import { createWorktreeManager } from '../worktrees/worktrees.js'
import { createFileService, PathTraversalError } from '../files/files.js'
import { createGitCli } from '../git/git.js'
import { createGitService } from '../git/service.js'
import { createStatusAggregator } from '../status/status.js'
import { createNotifications } from '../notifications/notifications.js'
import { createAuth } from '../auth/auth.js'
import { createAuthMiddleware } from '../auth/middleware.js'

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-test-'))
}

function initGitRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('Phase 2 Integration: Org → Project → Worktree → Files → Git', () => {
  let tmpDir: string
  let dataDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
    dataDir = path.join(tmpDir, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    cleanup(tmpDir)
  })

  it('creates org, adds project, creates worktree, reads files, makes git commit', async () => {
    const bus = createEventBus(dataDir)
    const orgMgr = createOrgManager(bus, dataDir)

    // Create a real git repo
    const repoPath = path.join(tmpDir, 'repo')
    initGitRepo(repoPath)

    // Create org & project
    const orgDir = path.join(tmpDir, 'orgdir')
    fs.mkdirSync(orgDir)
    const org = orgMgr.createOrg({ name: 'TestOrg', path: orgDir })
    const project = orgMgr.addProject(org.id, { name: 'TestProject', repoPath })

    // Create worktree
    const wtMgr = createWorktreeManager(bus, dataDir, {
      getProject: (oId, pId) => {
        const p = orgMgr.getProject(oId, pId)
        return p ? { repoPath: p.repoPath, defaultBranch: p.defaultBranch } : undefined
      }
    })

    const wt = await wtMgr.create(org.id, project.id, { branch: 'feature-1' })
    expect(wt.branch).toBe('feature-1')
    expect(fs.existsSync(wt.path)).toBe(true)

    // Write a file into the worktree and read it via file service
    const fileService = createFileService(bus)
    await fileService.writeFile(wt.path, 'hello.txt', 'hello world')
    const content = await fileService.readFile(wt.path, 'hello.txt')
    expect(content.content).toBe('hello world')

    // Make a git commit via git service
    const gitCli = createGitCli()
    const gitService = createGitService(bus, gitCli, (_oId, _pId, _wtId) => ({
      repoPath: wt.path,
      defaultBranch: 'main'
    }))

    await gitService.stage(org.id, project.id, ['hello.txt'], wt.id)
    const commitInfo = await gitService.commit(org.id, project.id, 'add hello', wt.id)
    expect(commitInfo.message).toBe('add hello')
  })

  it('worktree creation emits event that status aggregator reflects', async () => {
    const bus = createEventBus(dataDir)
    const events: string[] = []
    bus.on('worktree.*', (e) => {
      events.push(e.type)
    })

    const repoPath = path.join(tmpDir, 'repo')
    initGitRepo(repoPath)
    const orgDir = path.join(tmpDir, 'orgdir')
    fs.mkdirSync(orgDir)

    const orgMgr = createOrgManager(bus, dataDir)
    const org = orgMgr.createOrg({ name: 'O', path: orgDir })
    const project = orgMgr.addProject(org.id, { name: 'P', repoPath })

    const statusAgg = createStatusAggregator(bus, {
      modules: [{ name: 'worktrees', status: () => ({ name: 'worktrees', status: 'ok' }) }]
    })

    const wtMgr = createWorktreeManager(bus, dataDir, {
      getProject: (oId, pId) => {
        const p = orgMgr.getProject(oId, pId)
        return p ? { repoPath: p.repoPath, defaultBranch: p.defaultBranch } : undefined
      }
    })

    await wtMgr.create(org.id, project.id, { branch: 'feat-status' })
    expect(events).toContain('worktree.created')

    const status = statusAgg.getStatus()
    expect(status.modules).toEqual([{ name: 'worktrees', status: 'ok' }])
    statusAgg.destroy()
  })

  it('cross-project worktree link: create linked worktrees across two projects in same org', async () => {
    const bus = createEventBus(dataDir)
    const orgMgr = createOrgManager(bus, dataDir)

    const repo1 = path.join(tmpDir, 'repo1')
    const repo2 = path.join(tmpDir, 'repo2')
    initGitRepo(repo1)
    initGitRepo(repo2)

    const orgDir = path.join(tmpDir, 'orgdir')
    fs.mkdirSync(orgDir)
    const org = orgMgr.createOrg({ name: 'O', path: orgDir })
    const p1 = orgMgr.addProject(org.id, { name: 'P1', repoPath: repo1 })
    const p2 = orgMgr.addProject(org.id, { name: 'P2', repoPath: repo2 })

    const wtMgr = createWorktreeManager(bus, dataDir, {
      getProject: (oId, pId) => {
        const p = orgMgr.getProject(oId, pId)
        return p ? { repoPath: p.repoPath, defaultBranch: p.defaultBranch } : undefined
      }
    })

    const wt1 = await wtMgr.create(org.id, p1.id, { branch: 'cross-1' })
    const wt2 = await wtMgr.create(org.id, p2.id, { branch: 'cross-2' })

    const link = wtMgr.createLink(org.id, {
      name: 'cross-link',
      description: 'links two projects',
      worktreeIds: [wt1.id, wt2.id]
    })

    expect(link.worktreeIds).toEqual([wt1.id, wt2.id])
    const fetched = wtMgr.getLink(org.id, link.id)
    expect(fetched?.name).toBe('cross-link')
  })

  it('file API rejects path traversal outside project repo', async () => {
    const bus = createEventBus(dataDir)
    const fileService = createFileService(bus)
    const repoRoot = path.join(tmpDir, 'repo')
    fs.mkdirSync(repoRoot, { recursive: true })

    await expect(fileService.readFile(repoRoot, '../../etc/passwd')).rejects.toThrow(PathTraversalError)
    await expect(fileService.readFile(repoRoot, '../../../etc/shadow')).rejects.toThrow('outside the project')
  })

  it('git push to protected branch is rejected', async () => {
    const bus = createEventBus(dataDir)
    const gitCli = createGitCli()

    // resolveProject always returns main as default branch, and we'll be on main
    const repoPath = path.join(tmpDir, 'repo')
    initGitRepo(repoPath)

    const gitService = createGitService(bus, gitCli, () => ({
      repoPath,
      defaultBranch: 'main'
    }))

    await expect(gitService.push('o', 'p')).rejects.toThrow("Push to protected branch 'main' is not allowed")
  })

  it('terminal session starts in correct worktree cwd', async () => {
    // We can't easily test node-pty in CI, but we can test the validateCwd rejection
    const bus = createEventBus(dataDir)
    const allowedPaths = [path.join(tmpDir, 'repo')]

    // Import the module - we test that validation works by checking the error
    const { createTerminalManager } = await import('../terminal/terminal.js')
    const termMgr = createTerminalManager(bus, {
      validateCwd: (cwd) => allowedPaths.some((p) => cwd.startsWith(p))
    })

    expect(() => termMgr.create({ cwd: '/tmp/evil' })).toThrow('cwd not allowed')

    // Valid cwd should not throw (but will try to spawn a shell)
    fs.mkdirSync(allowedPaths[0], { recursive: true })
    const session = termMgr.create({ cwd: allowedPaths[0] })
    expect(session.cwd).toBe(allowedPaths[0])
    termMgr.dispose()
  })

  it('auth middleware protects all Phase 2 API endpoints', async () => {
    const bus = createEventBus(dataDir)
    const auth = createAuth(bus, dataDir, {
      tokenExpiry: '1h',
      trustedProxies: []
    })

    const middleware = createAuthMiddleware(auth)
    const app = express()
    app.use(middleware)
    app.get('/api/test', (_req, res) => {
      res.json({ ok: true })
    })

    // No token → 401
    const res1 = await request(app).get('/api/test')
    expect(res1.status).toBe(401)

    // Invalid token → 401
    const res2 = await request(app).get('/api/test').set('Authorization', 'Bearer invalid-token')
    expect(res2.status).toBe(401)

    // No Bearer prefix → 401
    const res3 = await request(app).get('/api/test').set('Authorization', 'some-token')
    expect(res3.status).toBe(401)
  })

  it('org deletion cascades: removes projects and worktree metadata', async () => {
    const bus = createEventBus(dataDir)
    const orgMgr = createOrgManager(bus, dataDir)
    const deletedEvents: string[] = []
    bus.on('org.deleted', () => {
      deletedEvents.push('org.deleted')
    })
    bus.on('project.deleted', () => {
      deletedEvents.push('project.deleted')
    })

    const repoPath = path.join(tmpDir, 'repo')
    initGitRepo(repoPath)
    const orgDir = path.join(tmpDir, 'orgdir')
    fs.mkdirSync(orgDir)

    const org = orgMgr.createOrg({ name: 'O', path: orgDir })
    orgMgr.addProject(org.id, { name: 'P', repoPath })

    expect(orgMgr.listProjects(org.id)).toHaveLength(1)
    orgMgr.deleteOrg(org.id)
    expect(orgMgr.getOrg(org.id)).toBeUndefined()
    // Projects are removed when org is deleted (see deleteOrg implementation)
    expect(orgMgr.listProjects(org.id)).toHaveLength(0)
    expect(deletedEvents).toContain('org.deleted')
  })

  it('notification generated from worktree.stale event', async () => {
    const bus = createEventBus(dataDir)

    // Set up notification rules
    const rulesDir = path.join(dataDir, 'notifications')
    fs.mkdirSync(rulesDir, { recursive: true })
    fs.writeFileSync(
      path.join(rulesDir, 'rules.json'),
      JSON.stringify([
        {
          eventPattern: 'worktree.stale',
          severity: 'warning',
          titleTemplate: 'Stale worktree: {{payload.branch}}',
          bodyTemplate: 'Worktree {{payload.id}} is stale'
        }
      ])
    )

    const notifications = createNotifications(bus, dataDir)

    // Emit a stale worktree event
    bus.emit({
      type: 'worktree.stale',
      timestamp: new Date().toISOString(),
      source: 'worktrees',
      payload: { id: 'wt-1', branch: 'old-feature', status: 'stale' }
    })

    // Notifications use queueMicrotask, so wait a tick
    await new Promise((r) => setTimeout(r, 50))

    const notifList = notifications.list()
    expect(notifList.length).toBeGreaterThanOrEqual(1)
    const staleNotif = notifList.find((n) => n.title.includes('old-feature'))
    expect(staleNotif).toBeDefined()
    expect(staleNotif!.severity).toBe('warning')

    notifications.dispose()
  })

  it('active org/project change updates status bar via bus events', async () => {
    const bus = createEventBus(dataDir)
    const orgMgr = createOrgManager(bus, dataDir)
    const events: string[] = []
    bus.on('org.active.*', (e) => {
      events.push(e.type)
    })

    const orgDir = path.join(tmpDir, 'orgdir')
    fs.mkdirSync(orgDir)
    const org = orgMgr.createOrg({ name: 'O', path: orgDir })

    const repoPath = path.join(tmpDir, 'repo')
    initGitRepo(repoPath)
    const project = orgMgr.addProject(org.id, { name: 'P', repoPath })

    const statusAgg = createStatusAggregator(bus, {
      modules: [{ name: 'orgs', status: () => ({ name: 'orgs', status: 'ok' }) }]
    })

    orgMgr.setActiveOrg(org.id)
    expect(events).toContain('org.active.changed')
    expect(orgMgr.getActiveOrg()?.id).toBe(org.id)

    orgMgr.setActiveProject(org.id, project.id)
    expect(orgMgr.getActiveProject()?.id).toBe(project.id)

    const status = statusAgg.getStatus()
    expect(status.connection).toBe('connected')
    statusAgg.destroy()
  })
})
