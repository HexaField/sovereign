// Git remote parsing — extracted from the entry point so consumers
// (planning, drafts, etc.) get a stable function rather than each parsing
// `.git/config` themselves.

import fs from 'node:fs'
import path from 'node:path'
import type { ForgeKind } from '@sovereign/core'
import type { OrgManager } from './orgs.js'

export interface ParsedRemote {
  name: string
  provider: 'github' | 'radicle'
  repo?: string
  rid?: string
  /** "github.com", a self-hosted GitHub host, or "radicle" for rad: remotes. */
  host?: string
  url?: string
}

/** A remote on any forge Sovereign knows of (or will). */
export interface ForgeRemote {
  /** The git remote's name ("origin"). */
  name: string
  forge: ForgeKind
  /** "github.com", a self-hosted host, or "radicle" for rad: remotes. */
  host: string
  /** "owner/name" (GitLab: may hold subgroups) or the Radicle RID. */
  repo: string
  url: string
}

/** Host → forge. Hosts not listed here (and not github.com) are ignored. */
export type HostForges = Record<string, ForgeKind>

const DEFAULT_HOSTS: HostForges = { 'github.com': 'github' }

/** Other names of a host: GitHub's SSH-over-443 endpoint and the www form. */
const HOST_ALIASES: Record<string, string> = { 'ssh.github.com': 'github.com', 'www.github.com': 'github.com' }

/** Host the radicle remotes report (they have no network host). */
export const RADICLE_HOST = 'radicle'

/**
 * The config file that holds a checkout's remotes. A normal clone keeps it at
 * `.git/config`; a linked worktree has a `.git` *file* ("gitdir: …") pointing
 * at `<main>/.git/worktrees/<name>`, whose `commondir` leads back to the main
 * `.git` — that is where the remotes live. Submodules use the same file form.
 */
export function gitConfigPath(repoPath: string): string | undefined {
  const dotGit = path.join(repoPath, '.git')
  let stat: fs.Stats
  try {
    stat = fs.statSync(dotGit)
  } catch {
    return undefined
  }
  let gitDir = dotGit
  if (stat.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf-8'))
    if (!m) return undefined
    gitDir = path.resolve(repoPath, m[1].trim())
  }
  let commonDir = gitDir
  const commonFile = path.join(gitDir, 'commondir')
  if (fs.existsSync(commonFile)) {
    commonDir = path.resolve(gitDir, fs.readFileSync(commonFile, 'utf-8').trim())
  }
  const config = path.join(commonDir, 'config')
  return fs.existsSync(config) ? config : undefined
}

/** Split a remote URL into host and path. Handles https://, ssh://, git:// and scp-like `user@host:path`. */
export function splitRemoteUrl(url: string): { host: string; path: string } | undefined {
  const u = url.trim()
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u)
  if (scheme) return { host: scheme[1].toLowerCase(), path: scheme[2] }
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(u)
  if (scp && !/^rad$/i.test(scp[1])) return { host: scp[1].toLowerCase(), path: scp[2] }
  return undefined
}

function repoFromPath(p: string, forge: ForgeKind): string | undefined {
  const parts = p
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  // GitHub and Gitea repos are exactly owner/name; GitLab allows subgroups.
  if (forge === 'gitlab') return parts.length >= 2 ? parts.join('/') : undefined
  return parts.length === 2 ? parts.join('/') : undefined
}

/** Read `[remote "…"] url = …` pairs from a git config file's text. */
function readRemoteUrls(config: string): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = []
  const remoteRegex = /\[remote\s+"([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/g
  let match
  while ((match = remoteRegex.exec(config)) !== null) {
    const urlMatch = match[2].match(/^\s*url\s*=\s*(.+)$/m)
    if (urlMatch) out.push({ name: match[1], url: urlMatch[1].trim() })
  }
  return out
}

/**
 * Every remote of a checkout (clone or linked worktree) that lives on a known
 * forge. `hosts` adds self-hosted forges (`{ "git.example.org": "gitea" }`);
 * github.com is always known, and `rad:` remotes are always Radicle.
 */
export function parseForgeRemotes(repoPath: string, hosts?: HostForges): ForgeRemote[] {
  try {
    const configPath = gitConfigPath(repoPath)
    if (!configPath) return []
    const known: HostForges = { ...DEFAULT_HOSTS }
    for (const [h, f] of Object.entries(hosts ?? {})) known[h.toLowerCase()] = f
    const remotes: ForgeRemote[] = []
    for (const { name, url } of readRemoteUrls(fs.readFileSync(configPath, 'utf-8'))) {
      const rad = /^rad:(?:\/\/)?(.+)$/.exec(url)
      if (rad) {
        remotes.push({ name, forge: 'radicle', host: RADICLE_HOST, repo: rad[1].replace(/\/.*$/, ''), url })
        continue
      }
      const split = splitRemoteUrl(url)
      if (!split) continue
      const host = HOST_ALIASES[split.host] ?? split.host
      const forge = known[host]
      if (!forge) continue
      const repo = repoFromPath(split.path, forge)
      if (repo) remotes.push({ name, forge, host, repo, url })
    }
    return remotes
  } catch {
    return []
  }
}

export interface ProjectRemote extends ParsedRemote {
  projectId?: string
}

/**
 * The GitHub and Radicle remotes of one checkout — a clone or a linked
 * worktree. `hosts` can map a self-hosted GitHub (Enterprise) host to
 * 'github'; remotes on other forges are left out here, see parseForgeRemotes.
 */
export function parseGitRemotes(repoPath: string, hosts?: HostForges): ParsedRemote[] {
  const out: ParsedRemote[] = []
  for (const r of parseForgeRemotes(repoPath, hosts)) {
    if (r.forge === 'github') out.push({ name: r.name, provider: 'github', repo: r.repo, host: r.host, url: r.url })
    else if (r.forge === 'radicle')
      out.push({ name: r.name, provider: 'radicle', rid: r.repo, host: r.host, url: r.url })
  }
  return out
}

/**
 * Lookup remotes for a project, optionally narrowed by projectId. When
 * `projectId` is empty, all projects in the org are scanned.
 */
export function getRemotes(orgManager: OrgManager, orgId: string, projectId: string): ProjectRemote[] {
  const allRemotes: ProjectRemote[] = []

  let projects: Array<{ id: string; repoPath: string }> = []
  if (projectId) {
    const project = orgManager.getProject(orgId, projectId)
    if (project) projects = [project]
    else {
      const all = orgManager.listProjects(orgId)
      const match = all.find((p) => p.id === projectId || p.name === projectId)
      if (match) projects = [match]
    }
  } else {
    projects = orgManager.listProjects(orgId)
  }

  for (const project of projects) {
    const remotes = parseGitRemotes(project.repoPath)
    for (const remote of remotes) {
      allRemotes.push({ ...remote, projectId: project.id })
    }
  }

  return allRemotes
}
