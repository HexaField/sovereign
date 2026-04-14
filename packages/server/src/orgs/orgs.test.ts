import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { createEventBus } from '@sovereign/core'
import type { BusEvent } from '@sovereign/core'
import { createOrgManager, type OrgManager } from './orgs.js'
import { createOrgStore } from './store.js'
import { createOrgRoutes } from './routes.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-orgs-test-'))
}

function fakeGitRepo(base: string, name: string = 'repo'): string {
  const p = path.join(base, name)
  fs.mkdirSync(path.join(p, '.git'), { recursive: true })
  return p
}

function fakeGitRepoWithConfig(base: string, name: string, config: string): string {
  const p = fakeGitRepo(base, name)
  fs.writeFileSync(path.join(p, '.git', 'config'), config)
  return p
}

let dataDir: string
let tempBase: string
let bus: ReturnType<typeof createEventBus>
let manager: OrgManager
let events: BusEvent[]

beforeEach(() => {
  dataDir = tmpDir()
  tempBase = tmpDir()
  bus = createEventBus(dataDir)
  events = []
  bus.on('org.*', (e) => {
    events.push(e)
  })
  bus.on('project.*', (e) => {
    events.push(e)
  })
  manager = createOrgManager(bus, dataDir)
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(tempBase, { recursive: true, force: true })
})

describe('Org Manager', () => {
  // Org CRUD
  it('creates an org with id, name, path, timestamps', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    expect(org.id).toBeTruthy()
    expect(org.name).toBe('Test')
    expect(org.path).toBe(tempBase)
    expect(org.createdAt).toBeTruthy()
    expect(org.updatedAt).toBeTruthy()
  })

  it('updates an org', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const updated = manager.updateOrg(org.id, { name: 'Updated' })
    expect(updated.name).toBe('Updated')
    expect(updated.updatedAt).toBeTruthy()
  })

  it('deletes an org', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.deleteOrg(org.id)
    expect(manager.getOrg(org.id)).toBeUndefined()
  })

  it('gets an org by id', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    expect(manager.getOrg(org.id)).toEqual(org)
  })

  it('lists all orgs', () => {
    manager.createOrg({ name: 'A', path: tempBase })
    const dir2 = tmpDir()
    manager.createOrg({ name: 'B', path: dir2 })
    expect(manager.listOrgs()).toHaveLength(2)
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  it('rejects creating org with non-existent path', () => {
    expect(() => manager.createOrg({ name: 'X', path: '/no/such/path' })).toThrow()
  })

  // Project CRUD
  it('adds a project to an org', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const project = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    expect(project.id).toBeTruthy()
    expect(project.orgId).toBe(org.id)
    expect(project.repoPath).toBe(repo)
  })

  it('validates project repoPath exists and is a git repo', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const project = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    expect(project).toBeTruthy()
  })

  it('rejects project with non-git directory', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const dir = path.join(tempBase, 'notgit')
    fs.mkdirSync(dir)
    expect(() => manager.addProject(org.id, { name: 'proj', repoPath: dir })).toThrow(/not a git repo/)
  })

  it('rejects project if repoPath already belongs to another org', () => {
    const org1 = manager.createOrg({ name: 'A', path: tempBase })
    const dir2 = tmpDir()
    const org2 = manager.createOrg({ name: 'B', path: dir2 })
    const repo = fakeGitRepo(tempBase)
    manager.addProject(org1.id, { name: 'p1', repoPath: repo })
    expect(() => manager.addProject(org2.id, { name: 'p2', repoPath: repo })).toThrow(/already belongs/)
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  it('updates a project', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const project = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    const updated = manager.updateProject(org.id, project.id, { name: 'renamed' })
    expect(updated.name).toBe('renamed')
  })

  it('derives project preferred remote from canonical org provider when remotes are discovered', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase, provider: 'radicle' })
    const repo = fakeGitRepoWithConfig(
      tempBase,
      'repo-with-remotes',
      `[remote "origin"]\n  url = git@github.com:secondary/repo.git\n[remote "rad"]\n  url = rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5\n`
    )

    const project = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    expect(project.remote).toBe('rad')
  })

  it('removes a project from an org', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const project = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    manager.removeProject(org.id, project.id)
    expect(manager.getProject(org.id, project.id)).toBeUndefined()
  })

  it('gets a project by id', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const project = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    expect(manager.getProject(org.id, project.id)).toEqual(project)
  })

  it('lists all projects for an org', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const r1 = fakeGitRepo(tempBase, 'r1')
    const r2 = fakeGitRepo(tempBase, 'r2')
    manager.addProject(org.id, { name: 'p1', repoPath: r1 })
    manager.addProject(org.id, { name: 'p2', repoPath: r2 })
    expect(manager.listProjects(org.id)).toHaveLength(2)
  })

  // Persistence
  it('persists orgs to disk on create', () => {
    manager.createOrg({ name: 'Test', path: tempBase })
    const store = createOrgStore(dataDir)
    expect(store.read().orgs).toHaveLength(1)
  })

  it('persists orgs to disk on update', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.updateOrg(org.id, { name: 'Updated' })
    const store = createOrgStore(dataDir)
    expect(store.read().orgs[0].name).toBe('Updated')
  })

  it('persists orgs to disk on delete', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.deleteOrg(org.id)
    const store = createOrgStore(dataDir)
    expect(store.read().orgs).toHaveLength(0)
  })

  it('recovers orgs and projects from disk on startup', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    manager.addProject(org.id, { name: 'proj', repoPath: repo })

    const manager2 = createOrgManager(bus, dataDir)
    expect(manager2.listOrgs()).toHaveLength(1)
    expect(manager2.listProjects(org.id)).toHaveLength(1)
  })

  // Events
  it('emits org.created on the bus', () => {
    manager.createOrg({ name: 'Test', path: tempBase })
    expect(events.some((e) => e.type === 'org.created')).toBe(true)
  })

  it('emits org.updated on the bus', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.updateOrg(org.id, { name: 'X' })
    expect(events.some((e) => e.type === 'org.updated')).toBe(true)
  })

  it('emits org.deleted on the bus', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.deleteOrg(org.id)
    expect(events.some((e) => e.type === 'org.deleted')).toBe(true)
  })

  it('emits project.created on the bus', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    manager.addProject(org.id, { name: 'proj', repoPath: repo })
    expect(events.some((e) => e.type === 'project.created')).toBe(true)
  })

  it('emits project.updated on the bus', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    manager.updateProject(org.id, p.id, { name: 'x' })
    expect(events.some((e) => e.type === 'project.updated')).toBe(true)
  })

  it('emits project.deleted on the bus', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    manager.removeProject(org.id, p.id)
    expect(events.some((e) => e.type === 'project.deleted')).toBe(true)
  })

  // Monorepo detection
  it('detects pnpm workspace monorepo', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'mono')
    fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    const pkgDir = path.join(repo, 'packages', 'a')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}')
    const p = manager.addProject(org.id, { name: 'mono', repoPath: repo })
    expect(p.monorepo?.tool).toBe('pnpm')
    expect(p.monorepo?.packages).toContain('packages/a')
  })

  it('detects npm workspaces monorepo', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'npmm')
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
    const pkgDir = path.join(repo, 'packages', 'b')
    fs.mkdirSync(pkgDir, { recursive: true })
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{}')
    const p = manager.addProject(org.id, { name: 'npmm', repoPath: repo })
    expect(p.monorepo?.tool).toBe('npm')
  })

  it('detects nx monorepo', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'nxr')
    fs.writeFileSync(path.join(repo, 'nx.json'), '{}')
    const p = manager.addProject(org.id, { name: 'nxr', repoPath: repo })
    expect(p.monorepo?.tool).toBe('nx')
  })

  it('detects turborepo monorepo', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'turbo')
    fs.writeFileSync(path.join(repo, 'turbo.json'), '{}')
    const p = manager.addProject(org.id, { name: 'turbo', repoPath: repo })
    expect(p.monorepo?.tool).toBe('turborepo')
  })

  it('returns undefined monorepo for non-monorepo project', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'plain')
    const p = manager.addProject(org.id, { name: 'plain', repoPath: repo })
    expect(p.monorepo).toBeUndefined()
  })

  // Auto-detect projects
  it('autoDetectProjects finds git repos in org path', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    fakeGitRepo(tempBase, 'project-a')
    fakeGitRepo(tempBase, 'project-b')
    const added = manager.autoDetectProjects(org.id)
    expect(added).toHaveLength(2)
    expect(added.map((p) => p.name).sort()).toEqual(['project-a', 'project-b'])
  })

  it('autoDetectProjects detects org path itself as git repo', () => {
    const repoDir = fakeGitRepo(tempBase, 'myrepo')
    const org = manager.createOrg({ name: 'Test', path: repoDir })
    const added = manager.autoDetectProjects(org.id)
    expect(added).toHaveLength(1)
    expect(added[0].name).toBe('myrepo')
  })

  it('autoDetectProjects skips already registered projects', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'existing')
    manager.addProject(org.id, { name: 'existing', repoPath: repo })
    const added = manager.autoDetectProjects(org.id)
    expect(added).toHaveLength(0)
  })

  it('autoDetectProjects skips hidden dirs and node_modules', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    // hidden dir with .git
    fs.mkdirSync(path.join(tempBase, '.hidden', '.git'), { recursive: true })
    // node_modules with .git
    fs.mkdirSync(path.join(tempBase, 'node_modules', '.git'), { recursive: true })
    // valid project
    fakeGitRepo(tempBase, 'valid')
    const added = manager.autoDetectProjects(org.id)
    expect(added).toHaveLength(1)
    expect(added[0].name).toBe('valid')
  })

  it('autoDetectProjects skips non-git subdirectories', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    fs.mkdirSync(path.join(tempBase, 'not-a-repo'))
    fakeGitRepo(tempBase, 'real-repo')
    const added = manager.autoDetectProjects(org.id)
    expect(added).toHaveLength(1)
  })

  // Active context
  it('sets and gets active org', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.setActiveOrg(org.id)
    expect(manager.getActiveOrg()?.id).toBe(org.id)
  })

  it('sets and gets active project', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    manager.setActiveProject(org.id, p.id)
    expect(manager.getActiveProject()?.id).toBe(p.id)
  })

  it('emits org.active.changed on active org change', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.setActiveOrg(org.id)
    expect(events.some((e) => e.type === 'org.active.changed')).toBe(true)
  })

  it('emits project.active.changed on active project change', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    manager.setActiveProject(org.id, p.id)
    expect(events.some((e) => e.type === 'project.active.changed')).toBe(true)
  })

  // Config
  it('reads per-org config', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const config = manager.getOrgConfig(org.id)
    expect(config).toEqual({})
  })

  it('updates per-org config', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.updateOrgConfig(org.id, { key: 'value' })
    expect(manager.getOrgConfig(org.id)).toEqual({ key: 'value' })
  })

  it('hot-reloads per-org config without restart', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    manager.updateOrgConfig(org.id, { a: 1 })
    // Directly modify the config file to simulate external change
    const configPath = path.join(dataDir, 'orgs', org.id, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ a: 2, b: 3 }))
    // Reading should get fresh data (reads from disk each time)
    expect(manager.getOrgConfig(org.id)).toEqual({ a: 2, b: 3 })
  })

  // Constraints
  it('does not create or modify files inside user git repos', () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase, 'saferepo')
    const before = fs.readdirSync(repo)
    manager.addProject(org.id, { name: 'safe', repoPath: repo })
    const after = fs.readdirSync(repo)
    expect(after).toEqual(before)
  })
})

describe('Org Manager Routes', () => {
  let app: express.Express

  beforeEach(() => {
    app = express()
    app.use(express.json())
    // Auth middleware: check for Bearer token
    const authMw = (req: any, res: any, next: any) => {
      const auth = req.headers.authorization
      if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
      next()
    }
    app.use('/api', createOrgRoutes(manager, authMw))
  })

  const auth = { Authorization: 'Bearer test-token' }

  it('GET /api/orgs returns org list', async () => {
    manager.createOrg({ name: 'Test', path: tempBase })
    const res = await request(app).get('/api/orgs').set(auth)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('POST /api/orgs creates an org', async () => {
    const res = await request(app).post('/api/orgs').set(auth).send({ name: 'New', path: tempBase })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('New')
  })

  it('GET /api/orgs/:orgId returns an org', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const res = await request(app).get(`/api/orgs/${org.id}`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(org.id)
  })

  it('PUT /api/orgs/:orgId updates an org', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const res = await request(app).put(`/api/orgs/${org.id}`).set(auth).send({ name: 'Updated' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Updated')
  })

  it('DELETE /api/orgs/:orgId deletes an org', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const res = await request(app).delete(`/api/orgs/${org.id}`).set(auth)
    expect(res.status).toBe(204)
  })

  it('GET /api/orgs/:orgId/projects returns project list', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    manager.addProject(org.id, { name: 'proj', repoPath: repo })
    const res = await request(app).get(`/api/orgs/${org.id}/projects`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('POST /api/orgs/:orgId/projects adds a project', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const res = await request(app).post(`/api/orgs/${org.id}/projects`).set(auth).send({ name: 'proj', repoPath: repo })
    expect(res.status).toBe(201)
  })

  it('GET /api/orgs/:orgId/projects/:projectId returns a project', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    const res = await request(app).get(`/api/orgs/${org.id}/projects/${p.id}`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(p.id)
  })

  it('PUT /api/orgs/:orgId/projects/:projectId updates a project', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    const res = await request(app).put(`/api/orgs/${org.id}/projects/${p.id}`).set(auth).send({ name: 'updated' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('updated')
  })

  it('DELETE /api/orgs/:orgId/projects/:projectId removes a project', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    const repo = fakeGitRepo(tempBase)
    const p = manager.addProject(org.id, { name: 'proj', repoPath: repo })
    const res = await request(app).delete(`/api/orgs/${org.id}/projects/${p.id}`).set(auth)
    expect(res.status).toBe(204)
  })

  it('POST /api/orgs/:orgId/detect-projects auto-detects git repos', async () => {
    const org = manager.createOrg({ name: 'Test', path: tempBase })
    fakeGitRepo(tempBase, 'auto-proj')
    const res = await request(app).post(`/api/orgs/${org.id}/detect-projects`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.detected).toHaveLength(1)
    expect(res.body.detected[0].name).toBe('auto-proj')
  })

  it('all routes reject unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/orgs')
    expect(res.status).toBe(401)
  })
})

describe('Org Store', () => {
  it('reads orgs from disk', () => {
    const store = createOrgStore(dataDir)
    const data = store.read()
    expect(data).toEqual({ orgs: [], projects: [] })
  })

  it('writes orgs to disk atomically', () => {
    const store = createOrgStore(dataDir)
    store.write({ orgs: [{ id: '1', name: 'Test', path: '/tmp', createdAt: '', updatedAt: '' }], projects: [] })
    const data = store.read()
    expect(data.orgs).toHaveLength(1)
    // No .tmp file should remain
    const files = fs.readdirSync(path.join(dataDir, 'orgs'))
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
  })

  it('creates data directory if it does not exist', () => {
    const newDir = path.join(dataDir, 'nested', 'deep')
    const store = createOrgStore(newDir)
    store.read() // should not throw
  })
})
