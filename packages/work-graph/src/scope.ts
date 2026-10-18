// Scope of a membrane's Forge: membrane → orgs (workspaceIds) → projects →
// git remotes → forge repos, plus the repos config adds; and the plan
// directories to scan.

import fs from 'node:fs'
import path from 'node:path'
import { discoverRepos, repoKey, type ForgeRepo } from '@sovereign/forges'
import type { HostForges } from '@sovereign/orgs'

/** The slice of membranes + orgs the work graph reads. */
export interface ScopeSource {
  getMembrane(id: string): { id: string; workspaceIds: string[]; contentPath?: string } | undefined
  listMembranes(): Array<{ id: string; workspaceIds: string[]; contentPath?: string }>
  getOrg(id: string): { id: string; path: string } | undefined
  listProjects(orgId: string): Array<{ id: string; name: string; repoPath: string }>
}

export interface PlanDir {
  dir: string
  /** Project the plans belong to ("<org>/<project>", or the membrane id for membrane-wide dirs). */
  project: string
  /** The repo plans here name implicitly (their project's origin), for bare "#N". */
  repo?: string
}

export interface MembraneScope {
  membrane: string
  repos: ForgeRepo[]
  planDirs: PlanDir[]
}

/** "owner/name" or "host/owner/name" → a GitHub repo. */
export function parseRepoSpec(spec: string): Omit<ForgeRepo, 'checkouts'> | undefined {
  const s = spec
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length === 2) return { forge: 'github', host: 'github.com', repo: parts.join('/') }
  if (parts.length === 3 && parts[0].includes('.')) {
    return { forge: 'github', host: parts[0].toLowerCase(), repo: `${parts[1]}/${parts[2]}` }
  }
  return undefined
}

export function resolveScope(
  source: ScopeSource,
  membraneId: string,
  opts: { planDirs: string[]; repos?: Record<string, string[]>; hosts?: HostForges }
): MembraneScope | undefined {
  const membrane = source.getMembrane(membraneId)
  if (!membrane) return undefined
  const projects: Array<{ project: string; repoPath: string }> = []
  const orgs: Array<{ id: string; path: string }> = []
  for (const orgId of membrane.workspaceIds) {
    const org = source.getOrg(orgId)
    if (!org) continue
    orgs.push(org)
    for (const p of source.listProjects(orgId)) projects.push({ project: `${orgId}/${p.name}`, repoPath: p.repoPath })
  }

  const discovered = discoverRepos(
    projects.map((p) => p.repoPath),
    opts.hosts
  )
  // Opt-in: only the repos configured for the membrane sync. Discovery only
  // finds their local checkouts (worktree-aware remotes).
  const local = new Map(discovered.map((r) => [repoKey(r), r]))
  const byKey = new Map<string, ForgeRepo>()
  for (const spec of opts.repos?.[membraneId] ?? []) {
    const r = parseRepoSpec(spec)
    if (r && !byKey.has(repoKey(r))) byKey.set(repoKey(r), local.get(repoKey(r)) ?? { ...r, checkouts: [] })
  }
  const repos = [...byKey.values()].filter((r) => r.forge === 'github')

  // A project's own repo: the first remote its checkout names.
  const repoOf = (repoPath: string) => repos.find((r) => r.checkouts.some((c) => c.path === repoPath))?.repo

  const dirs: PlanDir[] = []
  const seen = new Set<string>()
  const add = (dir: string, project: string, repo?: string) => {
    const abs = path.resolve(dir)
    if (seen.has(abs)) return
    try {
      if (!fs.statSync(abs).isDirectory()) return
    } catch {
      return
    }
    seen.add(abs)
    dirs.push({ dir: abs, project, ...(repo ? { repo } : {}) })
  }
  for (const d of opts.planDirs) {
    if (path.isAbsolute(d)) {
      add(d, membraneId)
      continue
    }
    for (const p of projects) add(path.join(p.repoPath, d), p.project, repoOf(p.repoPath))
    for (const o of orgs) add(path.join(o.path, d), o.id)
    if (membrane.contentPath) add(path.join(membrane.contentPath, d), membraneId)
  }
  return { membrane: membraneId, repos, planDirs: dirs }
}
