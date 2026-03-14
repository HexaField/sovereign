import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EventBus, BusEvent } from '@sovereign/core'
import { createWorktreeManager, type WorktreeManager } from './worktrees.js'
import { createWorktreeStore } from './store.js'
import express from 'express'
import request from 'supertest'
import { createWorktreeRouter } from './routes.js'

let tmpDir: string
let repoPath: string
let dataDir: string
let events: BusEvent[]
let bus: EventBus
let manager: WorktreeManager

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'))
  repoPath = initRepo()
  dataDir = path.join(tmpDir, 'data')
  events = []
  bus = {
    emit: (e: BusEvent) => {
      events.push(e)
    },
    on: () => () => {},
    once: () => () => {},
    replay: () => (async function* () {})(),
    history: () => []
  }
  manager = createWorktreeManager(bus, dataDir, {
    runInstall: async () => {},
    getProject: (_orgId, projectId) => {
      if (projectId === 'proj1') return { repoPath, defaultBranch: 'main' }
      return undefined
    }
  })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('Worktree Manager', () => {
  // Creation
  it('creates a worktree via git worktree add', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-1' })
    expect(wt.branch).toBe('feat-1')
    expect(wt.status).toBe('active')
    expect(fs.existsSync(wt.path)).toBe(true)
    const branch = git(wt.path, 'branch', '--show-current')
    expect(branch).toBe('feat-1')
  })

  it('creates worktree in configurable location', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-loc' })
    expect(wt.path).toBe(path.join(repoPath, '.worktrees', 'feat-loc'))
  })

  it('runs package manager install after worktree creation', async () => {
    const installPaths: string[] = []
    const mgr = createWorktreeManager(bus, dataDir, {
      runInstall: async (p) => {
        installPaths.push(p)
      },
      getProject: () => ({ repoPath, defaultBranch: 'main' })
    })
    const wt = await mgr.create('org1', 'proj1', { branch: 'feat-install' })
    expect(installPaths).toContain(wt.path)
  })

  it('rejects worktree creation on default branch', async () => {
    await expect(manager.create('org1', 'proj1', { branch: 'main' })).rejects.toThrow(
      'Cannot create worktree on default branch'
    )
  })

  it('assigns a base branch to the worktree', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-base', baseBranch: 'main' })
    expect(wt.baseBranch).toBe('main')
  })

  // Listing & retrieval
  it('lists all worktrees for a project', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-a' })
    await manager.create('org1', 'proj1', { branch: 'feat-b' })
    const list = manager.list('org1', 'proj1')
    expect(list).toHaveLength(2)
  })

  it('gets a worktree by id', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-get' })
    const found = manager.get('org1', 'proj1', wt.id)
    expect(found).toBeDefined()
    expect(found!.id).toBe(wt.id)
  })

  it('includes branch, path, creation time, assigned agent, and status', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-fields' })
    expect(wt.branch).toBe('feat-fields')
    expect(wt.path).toBeTruthy()
    expect(wt.createdAt).toBeTruthy()
    expect(wt.status).toBe('active')
    expect(wt.assignedAgent).toBeUndefined()
  })

  // Removal
  it('removes a worktree via git worktree remove', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-rm' })
    await manager.remove('org1', 'proj1', wt.id)
    expect(fs.existsSync(wt.path)).toBe(false)
    expect(manager.get('org1', 'proj1', wt.id)).toBeUndefined()
  })

  it('prunes branch if merged when pruneBranch option is set', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-prune' })
    // No extra commits so branch is merged into main
    await manager.remove('org1', 'proj1', wt.id, { pruneBranch: true })
    const branches = git(repoPath, 'branch')
      .split('\n')
      .map((b) => b.trim().replace(/^\* /, ''))
    expect(branches).not.toContain('feat-prune')
  })

  // Assignment
  it('assigns an agent to a worktree', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-assign' })
    const updated = manager.assign('org1', 'proj1', wt.id, 'agent-1')
    expect(updated.assignedAgent).toBe('agent-1')
  })

  it('unassigns an agent from a worktree', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-unassign' })
    manager.assign('org1', 'proj1', wt.id, 'agent-1')
    const updated = manager.unassign('org1', 'proj1', wt.id)
    expect(updated.assignedAgent).toBeUndefined()
  })

  // Persistence
  it('persists worktree metadata to disk', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-persist' })
    const file = path.join(dataDir, 'orgs', 'org1', 'projects', 'proj1', 'worktrees.json')
    expect(fs.existsSync(file)).toBe(true)
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(data).toHaveLength(1)
    expect(data[0].branch).toBe('feat-persist')
  })

  it('recovers worktree metadata from disk on startup', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-recover' })
    // Create a new manager pointing at same dataDir
    const mgr2 = createWorktreeManager(bus, dataDir, {
      runInstall: async () => {},
      getProject: () => ({ repoPath, defaultBranch: 'main' })
    })
    const list = mgr2.list('org1', 'proj1')
    expect(list).toHaveLength(1)
    expect(list[0].branch).toBe('feat-recover')
  })

  // Events
  it('emits worktree.created on the bus', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-evt' })
    expect(events.some((e) => e.type === 'worktree.created')).toBe(true)
  })

  it('emits worktree.removed on the bus', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-rm-evt' })
    await manager.remove('org1', 'proj1', wt.id)
    expect(events.some((e) => e.type === 'worktree.removed')).toBe(true)
  })

  it('emits worktree.assigned on the bus', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-asgn-evt' })
    manager.assign('org1', 'proj1', wt.id, 'agent-1')
    expect(events.some((e) => e.type === 'worktree.assigned')).toBe(true)
  })

  it('emits worktree.merged on the bus', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-merge-evt' })
    await manager.remove('org1', 'proj1', wt.id, { pruneBranch: true })
    expect(events.some((e) => e.type === 'worktree.merged')).toBe(true)
  })

  it('emits worktree.stale on the bus for stale worktrees', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-stale-evt' })
    // Manually backdate the createdAt
    const store = createWorktreeStore(dataDir)
    const wts = store.readWorktrees('org1', 'proj1')
    wts[0].createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    store.writeWorktrees('org1', 'proj1', wts)

    manager.detectStale('org1', 'proj1', 14)
    expect(events.some((e) => e.type === 'worktree.stale')).toBe(true)
  })

  // Stale detection
  it('detects stale worktrees with no commits for configurable period', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-stale' })
    const store = createWorktreeStore(dataDir)
    const wts = store.readWorktrees('org1', 'proj1')
    wts[0].createdAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString()
    store.writeWorktrees('org1', 'proj1', wts)

    const stale = manager.detectStale('org1', 'proj1', 14)
    expect(stale).toHaveLength(1)
    expect(stale[0].status).toBe('stale')
  })

  // Cleanup
  it('cleans up merged worktree branches', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-cleanup' })
    // No extra commits — branch is merged into main
    const removed = await manager.cleanupMerged('org1', 'proj1')
    expect(removed).toContain(wt.id)
    expect(manager.list('org1', 'proj1')).toHaveLength(0)
  })

  // Constraints
  it('does not modify the main branch working tree', async () => {
    const headBefore = git(repoPath, 'rev-parse', 'HEAD')
    await manager.create('org1', 'proj1', { branch: 'feat-safe' })
    const headAfter = git(repoPath, 'rev-parse', 'HEAD')
    expect(headAfter).toBe(headBefore)
    const branch = git(repoPath, 'branch', '--show-current')
    expect(branch).toBe('main')
  })
})

describe('Worktree Store', () => {
  it('reads worktrees from disk', () => {
    const store = createWorktreeStore(dataDir)
    const result = store.readWorktrees('org1', 'proj1')
    expect(result).toEqual([])
  })

  it('writes worktrees to disk atomically', () => {
    const store = createWorktreeStore(dataDir)
    const wt = {
      id: 'wt1',
      projectId: 'proj1',
      orgId: 'org1',
      branch: 'feat',
      path: '/tmp/x',
      baseBranch: 'main',
      status: 'active' as const,
      createdAt: new Date().toISOString()
    }
    store.writeWorktrees('org1', 'proj1', [wt])
    const file = path.join(dataDir, 'orgs', 'org1', 'projects', 'proj1', 'worktrees.json')
    expect(fs.existsSync(file)).toBe(true)
    // tmp file should not exist (atomic rename)
    expect(fs.existsSync(file + '.tmp')).toBe(false)
  })

  it('creates data directory if it does not exist', () => {
    const store = createWorktreeStore(path.join(tmpDir, 'new-data'))
    store.writeWorktrees('org1', 'proj1', [])
    const dir = path.join(tmpDir, 'new-data', 'orgs', 'org1', 'projects', 'proj1')
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('Worktree Links', () => {
  it('creates a linked worktree set across projects', async () => {
    const wt1 = await manager.create('org1', 'proj1', { branch: 'feat-link-1' })
    const link = manager.createLink('org1', { name: 'cross-proj', worktreeIds: [wt1.id] })
    expect(link.name).toBe('cross-proj')
    expect(link.worktreeIds).toContain(wt1.id)
  })

  it('persists links to worktree-links.json', async () => {
    const wt1 = await manager.create('org1', 'proj1', { branch: 'feat-link-p' })
    manager.createLink('org1', { name: 'persisted', worktreeIds: [wt1.id] })
    const file = path.join(dataDir, 'orgs', 'org1', 'worktree-links.json')
    expect(fs.existsSync(file)).toBe(true)
  })

  it('lists links for an org', async () => {
    const wt1 = await manager.create('org1', 'proj1', { branch: 'feat-link-l' })
    manager.createLink('org1', { name: 'a', worktreeIds: [wt1.id] })
    expect(manager.listLinks('org1')).toHaveLength(1)
  })

  it('gets a link by id', async () => {
    const wt1 = await manager.create('org1', 'proj1', { branch: 'feat-link-g' })
    const link = manager.createLink('org1', { name: 'x', worktreeIds: [wt1.id] })
    expect(manager.getLink('org1', link.id)).toBeDefined()
  })

  it('removes a link', async () => {
    const wt1 = await manager.create('org1', 'proj1', { branch: 'feat-link-r' })
    const link = manager.createLink('org1', { name: 'x', worktreeIds: [wt1.id] })
    manager.removeLink('org1', link.id)
    expect(manager.listLinks('org1')).toHaveLength(0)
  })

  it('validates all referenced worktree ids exist', () => {
    expect(() => manager.createLink('org1', { name: 'bad', worktreeIds: ['nonexistent'] })).toThrow(
      'Worktree not found'
    )
  })
})

describe('Worktree Routes', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use(express.json())
    const noAuth = (_req: any, _res: any, next: () => void) => next()
    app.use(createWorktreeRouter(manager, noAuth))
  })

  it('GET /api/orgs/:orgId/projects/:projectId/worktrees returns list', async () => {
    await manager.create('org1', 'proj1', { branch: 'feat-route-list' })
    const res = await request(app).get('/api/orgs/org1/projects/proj1/worktrees')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('POST /api/orgs/:orgId/projects/:projectId/worktrees creates worktree', async () => {
    const res = await request(app).post('/api/orgs/org1/projects/proj1/worktrees').send({ branch: 'feat-route-create' })
    expect(res.status).toBe(201)
    expect(res.body.branch).toBe('feat-route-create')
  })

  it('DELETE /api/orgs/:orgId/projects/:projectId/worktrees/:worktreeId removes worktree', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-route-del' })
    const res = await request(app).delete(`/api/orgs/org1/projects/proj1/worktrees/${wt.id}`)
    expect(res.status).toBe(204)
  })

  it('POST /api/orgs/:orgId/worktree-links creates a link', async () => {
    const wt = await manager.create('org1', 'proj1', { branch: 'feat-route-link' })
    const res = await request(app)
      .post('/api/orgs/org1/worktree-links')
      .send({ name: 'test-link', worktreeIds: [wt.id] })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('test-link')
  })

  it('all routes reject unauthenticated requests with 401', async () => {
    const authApp = express()
    authApp.use(express.json())
    const requireAuth = (_req: any, res: any, _next: () => void) => res.status(401).json({ error: 'Unauthorized' })
    authApp.use(createWorktreeRouter(manager, requireAuth))
    const res = await request(authApp).get('/api/orgs/org1/projects/proj1/worktrees')
    expect(res.status).toBe(401)
  })
})
