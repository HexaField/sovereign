import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { Org, Project } from './types.js'
import { createOrgStore, type OrgStore, type OrgStoreData } from './store.js'
import { detectMonorepo } from './monorepo.js'
import { getProjectPreferredRemote } from '../remotes/discovery.js'

export interface OrgManager {
  createOrg(data: { id?: string; name: string; path: string; provider?: 'radicle' | 'github' }): Org
  updateOrg(orgId: string, patch: Partial<Pick<Org, 'name' | 'path' | 'provider'>>): Org
  deleteOrg(orgId: string): void
  getOrg(orgId: string): Org | undefined
  listOrgs(): Org[]

  addProject(orgId: string, data: { name: string; repoPath: string }): Project
  updateProject(
    orgId: string,
    projectId: string,
    patch: Partial<Pick<Project, 'name' | 'repoPath' | 'remote' | 'defaultBranch'>>
  ): Project
  removeProject(orgId: string, projectId: string): void
  getProject(orgId: string, projectId: string): Project | undefined
  listProjects(orgId: string): Project[]

  setActiveOrg(orgId: string): void
  setActiveProject(orgId: string, projectId: string): void
  getActiveOrg(): Org | undefined
  getActiveProject(): Project | undefined

  getOrgConfig(orgId: string): Record<string, unknown>
  updateOrgConfig(orgId: string, patch: Record<string, unknown>): void

  autoDetectProjects(orgId: string): Project[]
  ensureGlobalWorkspace(): Org
}

export function createOrgManager(bus: EventBus, dataDir: string): OrgManager {
  const store: OrgStore = createOrgStore(dataDir)
  let state: OrgStoreData = store.read()
  let activeOrgId: string | undefined
  let activeProjectId: string | undefined

  const now = () => new Date().toISOString()
  const id = () => crypto.randomUUID()

  const emit = (type: string, payload: unknown) => {
    bus.emit({ type, timestamp: now(), source: 'orgs', payload })
  }

  const save = () => store.write(state)

  const createOrg = (data: { id?: string; name: string; path: string; provider?: 'radicle' | 'github' }): Org => {
    if (!fs.existsSync(data.path)) throw new Error(`Path does not exist: ${data.path}`)
    const org: Org = {
      id: data.id || id(),
      name: data.name,
      path: data.path,
      provider: data.provider,
      createdAt: now(),
      updatedAt: now()
    }
    state.orgs.push(org)
    save()
    emit('org.created', org)
    return org
  }

  const updateOrg = (orgId: string, patch: Partial<Pick<Org, 'name' | 'path' | 'provider'>>): Org => {
    const org = state.orgs.find((o) => o.id === orgId)
    if (!org) throw new Error(`Org not found: ${orgId}`)
    if (orgId === '_global' && patch.provider === 'github') {
      const err = new Error('Cannot change _global provider to github') as any
      err.status = 403
      throw err
    }
    if (patch.name !== undefined) org.name = patch.name
    if (patch.path !== undefined) org.path = patch.path
    if (patch.provider !== undefined) org.provider = patch.provider
    org.updatedAt = now()
    save()
    emit('org.updated', org)
    return org
  }

  const deleteOrg = (orgId: string): void => {
    if (orgId === '_global') {
      const err = new Error('Cannot delete _global workspace') as any
      err.status = 403
      throw err
    }
    const idx = state.orgs.findIndex((o) => o.id === orgId)
    if (idx === -1) throw new Error(`Org not found: ${orgId}`)
    const org = state.orgs[idx]
    state.projects = state.projects.filter((p) => p.orgId !== orgId)
    state.orgs.splice(idx, 1)
    save()
    emit('org.deleted', org)
  }

  const getOrg = (orgId: string) => state.orgs.find((o) => o.id === orgId)
  const listOrgs = () => [...state.orgs]

  const addProject = (orgId: string, data: { name: string; repoPath: string }): Project => {
    if (!getOrg(orgId)) throw new Error(`Org not found: ${orgId}`)
    if (!fs.existsSync(data.repoPath)) throw new Error(`repoPath does not exist: ${data.repoPath}`)
    if (!fs.existsSync(`${data.repoPath}/.git`)) throw new Error(`repoPath is not a git repo: ${data.repoPath}`)
    const existing = state.projects.find((p) => p.repoPath === data.repoPath)
    if (existing) throw new Error(`repoPath already belongs to org ${existing.orgId}`)

    const mono = detectMonorepo(data.repoPath)
    const org = getOrg(orgId)
    const project: Project = {
      id: id(),
      orgId,
      name: data.name,
      repoPath: data.repoPath,
      remote: getProjectPreferredRemote(org, undefined, data.repoPath),
      defaultBranch: 'main',
      monorepo: mono || undefined,
      createdAt: now(),
      updatedAt: now()
    }
    state.projects.push(project)
    save()
    emit('project.created', project)
    return project
  }

  const updateProject = (
    orgId: string,
    projectId: string,
    patch: Partial<Pick<Project, 'name' | 'repoPath' | 'remote' | 'defaultBranch'>>
  ): Project => {
    const project = state.projects.find((p) => p.id === projectId && p.orgId === orgId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    if (patch.name !== undefined) project.name = patch.name
    if (patch.repoPath !== undefined) project.repoPath = patch.repoPath
    if (patch.remote !== undefined) project.remote = patch.remote
    if (patch.defaultBranch !== undefined) project.defaultBranch = patch.defaultBranch
    project.updatedAt = now()
    save()
    emit('project.updated', project)
    return project
  }

  const removeProject = (orgId: string, projectId: string): void => {
    const idx = state.projects.findIndex((p) => p.id === projectId && p.orgId === orgId)
    if (idx === -1) throw new Error(`Project not found: ${projectId}`)
    const project = state.projects[idx]
    state.projects.splice(idx, 1)
    save()
    emit('project.deleted', project)
  }

  const getProject = (orgId: string, projectId: string) =>
    state.projects.find((p) => p.id === projectId && p.orgId === orgId)
  const listProjects = (orgId: string) => state.projects.filter((p) => p.orgId === orgId)

  const setActiveOrg = (orgId: string): void => {
    if (!getOrg(orgId)) throw new Error(`Org not found: ${orgId}`)
    activeOrgId = orgId
    activeProjectId = undefined
    emit('org.active.changed', { orgId })
  }

  const setActiveProject = (orgId: string, projectId: string): void => {
    if (!getProject(orgId, projectId)) throw new Error(`Project not found: ${projectId}`)
    activeOrgId = orgId
    activeProjectId = projectId
    emit('project.active.changed', { orgId, projectId })
  }

  const getActiveOrg = () => (activeOrgId ? getOrg(activeOrgId) : undefined)
  const getActiveProject = () => (activeOrgId && activeProjectId ? getProject(activeOrgId, activeProjectId) : undefined)

  const getOrgConfig = (orgId: string): Record<string, unknown> => {
    if (!getOrg(orgId)) throw new Error(`Org not found: ${orgId}`)
    return store.readOrgConfig(orgId)
  }

  const updateOrgConfig = (orgId: string, patch: Record<string, unknown>): void => {
    if (!getOrg(orgId)) throw new Error(`Org not found: ${orgId}`)
    const current = store.readOrgConfig(orgId)
    const merged = { ...current, ...patch }
    store.writeOrgConfig(orgId, merged)
    emit('org.config.updated', { orgId, config: merged })
  }

  const ensureGlobalWorkspace = (): Org => {
    const existing = getOrg('_global')
    if (existing) return existing
    const globalDir = path.join(dataDir, 'orgs', '_global')
    if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true })
    const org: Org = {
      id: '_global',
      name: 'Global',
      path: globalDir,
      provider: 'radicle',
      createdAt: now(),
      updatedAt: now()
    }
    state.orgs.push(org)
    save()
    emit('org.created', org)
    return org
  }

  const SKIP_DIRS = new Set(['.git', 'node_modules', '.sovereign-data'])
  const DEFAULT_IGNORE = ['node_modules', 'vendor', 'dist', '.git']

  function loadIgnorePatterns(orgPath: string): string[] {
    const ignoreFile = path.join(orgPath, '.sovereign-ignore')
    try {
      if (!fs.existsSync(ignoreFile)) return DEFAULT_IGNORE
      const content = fs.readFileSync(ignoreFile, 'utf-8')
      const patterns = content
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
      return [...new Set([...DEFAULT_IGNORE, ...patterns])]
    } catch {
      return DEFAULT_IGNORE
    }
  }

  function matchesIgnorePattern(dirPath: string, orgPath: string, patterns: string[]): boolean {
    const rel = path.relative(orgPath, dirPath)
    const parts = rel.split(path.sep)
    for (const pattern of patterns) {
      // Simple matching: if any path segment matches the pattern, ignore
      if (parts.some((p) => p === pattern)) return true
      // Also check if the relative path contains the pattern as a segment
      if (rel.includes(`${pattern}/`) || rel.endsWith(pattern)) return true
    }
    return false
  }

  const autoDetectProjects = (orgId: string, opts?: { maxDepth?: number }): Project[] => {
    const org = getOrg(orgId)
    if (!org) throw new Error(`Org not found: ${orgId}`)

    const maxDepth = opts?.maxDepth ?? 2
    const ignorePatterns = loadIgnorePatterns(org.path)
    const existingPaths = new Set(state.projects.filter((p) => p.orgId === orgId).map((p) => p.repoPath))
    const added: Project[] = []

    const tryRegister = (dirPath: string) => {
      const resolved = path.resolve(dirPath)
      if (existingPaths.has(resolved)) return
      if (!fs.existsSync(path.join(resolved, '.git'))) return
      if (matchesIgnorePattern(resolved, org.path, ignorePatterns)) return
      try {
        const project = addProject(orgId, { name: path.basename(resolved), repoPath: resolved })
        added.push(project)
        existingPaths.add(resolved)
      } catch {
        // Already registered or invalid — skip
      }
    }

    // Check if org path itself is a git repo
    tryRegister(org.path)

    // Scan directories up to maxDepth
    const scanDir = (dirPath: string, depth: number) => {
      if (depth > maxDepth) return
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
          const fullPath = path.join(dirPath, entry.name)
          if (matchesIgnorePattern(fullPath, org.path, ignorePatterns)) continue
          tryRegister(fullPath)
          if (depth < maxDepth) scanDir(fullPath, depth + 1)
        }
      } catch {
        // Can't read directory — skip
      }
    }

    scanDir(org.path, 1)

    return added
  }

  return {
    createOrg,
    updateOrg,
    deleteOrg,
    getOrg,
    listOrgs,
    addProject,
    updateProject,
    removeProject,
    getProject,
    listProjects,
    setActiveOrg,
    setActiveProject,
    getActiveOrg,
    getActiveProject,
    getOrgConfig,
    updateOrgConfig,
    autoDetectProjects,
    ensureGlobalWorkspace
  }
}
