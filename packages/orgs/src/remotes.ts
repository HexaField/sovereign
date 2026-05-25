// Git remote parsing — extracted from the entry point so consumers
// (planning, drafts, etc.) get a stable function rather than each parsing
// `.git/config` themselves.

import fs from 'node:fs'
import path from 'node:path'
import type { OrgManager } from './orgs.js'

export interface ParsedRemote {
  name: string
  provider: 'github' | 'radicle'
  repo?: string
  rid?: string
}

export interface ProjectRemote extends ParsedRemote {
  projectId?: string
}

/** Parse `.git/config` and return the recognised remotes for a single repo. */
export function parseGitRemotes(repoPath: string): ParsedRemote[] {
  try {
    const gitConfigPath = path.join(repoPath, '.git', 'config')
    if (!fs.existsSync(gitConfigPath)) return []
    const config = fs.readFileSync(gitConfigPath, 'utf-8')
    const remotes: ParsedRemote[] = []

    const remoteRegex = /\[remote\s+"([^"]+)"\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/g
    let match
    while ((match = remoteRegex.exec(config)) !== null) {
      const remoteName = match[1]
      const section = match[2]
      const urlMatch = section.match(/url\s*=\s*(.+)/)
      if (!urlMatch) continue
      const url = urlMatch[1].trim()

      const ghSsh = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
      const ghHttps = url.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?\/?$/)
      if (ghSsh || ghHttps) {
        const repo = (ghSsh || ghHttps)![1]
        remotes.push({ name: remoteName, provider: 'github', repo })
        continue
      }

      const radMatch = url.match(/^rad:(.+)$/)
      if (radMatch) {
        remotes.push({ name: remoteName, provider: 'radicle', rid: radMatch[1] })
        continue
      }
    }

    return remotes
  } catch {
    return []
  }
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
