import fs from 'node:fs'
import path from 'node:path'
import type { Worktree, WorktreeLink } from './types.js'

export interface WorktreeStore {
  readWorktrees(orgId: string, projectId: string): Worktree[]
  writeWorktrees(orgId: string, projectId: string, worktrees: Worktree[]): void
  readLinks(orgId: string): WorktreeLink[]
  writeLinks(orgId: string, links: WorktreeLink[]): void
}

export function createWorktreeStore(dataDir: string): WorktreeStore {
  const ensureDir = (dir: string) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  const atomicWrite = (filePath: string, data: unknown) => {
    ensureDir(path.dirname(filePath))
    const tmp = filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, filePath)
  }

  const worktreesPath = (orgId: string, projectId: string) =>
    path.join(dataDir, 'orgs', orgId, 'projects', projectId, 'worktrees.json')

  const linksPath = (orgId: string) => path.join(dataDir, 'orgs', orgId, 'worktree-links.json')

  return {
    readWorktrees(orgId, projectId) {
      const p = worktreesPath(orgId, projectId)
      if (!fs.existsSync(p)) return []
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    },
    writeWorktrees(orgId, projectId, worktrees) {
      atomicWrite(worktreesPath(orgId, projectId), worktrees)
    },
    readLinks(orgId) {
      const p = linksPath(orgId)
      if (!fs.existsSync(p)) return []
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    },
    writeLinks(orgId, links) {
      atomicWrite(linksPath(orgId), links)
    }
  }
}
