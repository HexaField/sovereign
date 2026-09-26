// Finds the checkouts the code index keeps fresh: every directory up to
// MAX_DEPTH below an org root that holds a codegraph index, plus each linked
// worktree of such a repo. A worktree without an index comes back as
// `uninitialized` so the caller can create one — every worktree of an
// indexed repo gets an index, with no manual `codegraph init`.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { isIgnoredName } from '@sovereign/files'

const execFileAsync = promisify(execFile)

/** `org/repo` and `org/group/repo` layouts. Deeper checkouts are not scanned. */
export const MAX_DEPTH = 2

export interface DiscoveredRoots {
  /** Checkouts that have an index. */
  indexed: string[]
  /** Linked worktrees of an indexed repo that have no index yet. */
  uninitialized: string[]
}

export function hasIndex(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.codegraph', 'codegraph.db'))
}

/** True when `p` is `root` or lies inside it. */
export function isWithin(root: string, p: string): boolean {
  return p === root || p.startsWith(root + path.sep)
}

export async function discoverRoots(orgRoots: string[]): Promise<DiscoveredRoots> {
  const roots = [...new Set(orgRoots.map(realpath).filter((r): r is string => r !== null))]
  const indexed = new Set<string>()
  const repos: string[] = []
  for (const orgRoot of roots) {
    for (const dir of await candidateDirs(orgRoot)) {
      if (indexed.has(dir) || !hasIndex(dir)) continue // org roots may nest
      indexed.add(dir)
      if (isDirectory(path.join(dir, '.git'))) repos.push(dir)
    }
  }

  const uninitialized = new Set<string>()
  for (const repo of repos) {
    for (const wt of await linkedWorktrees(repo)) {
      // A worktree outside the org roots gets no file events, so leave it be.
      if (indexed.has(wt) || !roots.some((r) => isWithin(r, wt))) continue
      if (hasIndex(wt)) indexed.add(wt)
      else uninitialized.add(wt)
    }
  }
  return { indexed: [...indexed].sort(), uninitialized: [...uninitialized].sort() }
}

async function candidateDirs(orgRoot: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    out.push(dir)
    if (depth === MAX_DEPTH) return
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || isIgnoredName(e.name)) continue
      await walk(path.join(dir, e.name), depth + 1)
    }
  }
  if (isDirectory(orgRoot)) await walk(orgRoot, 0)
  return out
}

/** Paths of the repo's linked worktrees (not the main checkout) that exist on disk. */
async function linkedWorktrees(repo: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { timeout: 10_000 })
    return stdout
      .split('\n\n')
      .slice(1) // drop the main checkout
      .filter((block) => !/^prunable\b/m.test(block))
      .map((block) => /^worktree (.+)$/m.exec(block)?.[1])
      .map((p) => (p ? realpath(p) : null))
      .filter((p): p is string => p !== null)
  } catch {
    return []
  }
}

function realpath(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}
