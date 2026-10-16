// Repo discovery — which forge repos a set of checkouts (projects, and their
// linked worktrees) points at, deduplicated across checkouts and remotes.

import type { ForgeKind } from '@sovereign/core'
import { parseForgeRemotes, type HostForges } from '@sovereign/orgs'

export interface ForgeRepo {
  forge: ForgeKind
  host: string
  /** "owner/name" or a Radicle RID. */
  repo: string
  /** Every checkout and remote that points at this repo. */
  checkouts: Array<{ path: string; remote: string }>
}

/** "<forge>:<host>/<repo>" — the key two checkouts of one repo share. */
export function repoKey(r: Pick<ForgeRepo, 'forge' | 'host' | 'repo'>): string {
  return `${r.forge}:${r.host}/${r.repo}`
}

/**
 * The forge repos behind these checkouts. Order follows the first checkout
 * that names each repo; within a checkout `origin` comes first.
 */
export function discoverRepos(paths: string[], hosts?: HostForges): ForgeRepo[] {
  const out = new Map<string, ForgeRepo>()
  for (const p of paths) {
    const remotes = parseForgeRemotes(p, hosts).sort(
      (a, b) => Number(b.name === 'origin') - Number(a.name === 'origin')
    )
    for (const r of remotes) {
      const k = repoKey(r)
      let repo = out.get(k)
      if (!repo) {
        repo = { forge: r.forge, host: r.host, repo: r.repo, checkouts: [] }
        out.set(k, repo)
      }
      if (!repo.checkouts.some((c) => c.path === p && c.remote === r.name)) {
        repo.checkouts.push({ path: p, remote: r.name })
      }
    }
  }
  return [...out.values()]
}

/** The repo a checkout's `origin` (else its first known remote) points at. */
export function primaryRepo(path: string, hosts?: HostForges): Omit<ForgeRepo, 'checkouts'> | undefined {
  const remotes = parseForgeRemotes(path, hosts)
  const r = remotes.find((x) => x.name === 'origin') ?? remotes[0]
  return r ? { forge: r.forge, host: r.host, repo: r.repo } : undefined
}
