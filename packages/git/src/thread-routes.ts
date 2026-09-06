// Thread-centric git routes. Resolve threadId → workspace repos → git context,
// then expose context and diff endpoints the UI diff viewer consumes.

import { Router, type Request, type Response } from 'express'
import type { GitCli } from './git.js'
import type { ThreadGitContext, FileChange, CommitInfo } from './types.js'

/**
 * Resolves a threadId to an array of repo root paths the thread works in.
 * Returns empty array when the thread has no git context.
 * May be async to support lazy-loading from history logs.
 */
export type ThreadRepoResolver = (threadId: string) => string[] | Promise<string[]>

/** Parse a GitHub/GitLab remote URL into owner + repo. */
function parseRemote(url: string): { url: string; owner: string; repo: string } | null {
  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@([^:]+):([^/]+)\/([^/.]+)(?:\.git)?$/)
  if (sshMatch) {
    const host = sshMatch[1]
    return { url: `https://${host}/${sshMatch[2]}/${sshMatch[3]}`, owner: sshMatch[2], repo: sshMatch[3] }
  }
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/https?:\/\/([^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?$/)
  if (httpsMatch) {
    return {
      url: `https://${httpsMatch[1]}/${httpsMatch[2]}/${httpsMatch[3]}`,
      owner: httpsMatch[2],
      repo: httpsMatch[3]
    }
  }
  return null
}

/** Attempt to find an open PR for the current branch via GitHub API. */
async function fetchGitHubPr(
  owner: string,
  repo: string,
  branch: string
): Promise<{ number: number; url: string; state: string; title: string } | null> {
  try {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=1`
    const res = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {})
      },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const prs = (await res.json()) as Array<{
      number: number
      html_url: string
      state: string
      title: string
      draft?: boolean
    }>
    if (!prs.length) return null
    const pr = prs[0]
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.draft ? 'draft' : pr.state === 'closed' ? 'merged' : pr.state,
      title: pr.title
    }
  } catch {
    return null
  }
}

/**
 * Resolve the best base ref for merge-base computation.
 * Prefers `origin/<branch>` (remote tracking ref — stays current with fetch)
 * over the local `<branch>` (may not have been pulled in weeks).
 */
async function resolveBaseRef(gitCli: GitCli, repoRoot: string, baseBranch: string): Promise<string> {
  const remoteRef = `origin/${baseBranch}`
  const mergeBase = await gitCli.mergeBase(repoRoot, remoteRef)
  if (mergeBase) return remoteRef
  // No remote tracking ref — fall back to local branch
  return baseBranch
}

/** Build git context for a single repo root. */
async function buildRepoContext(gitCli: GitCli, repoRoot: string): Promise<ThreadGitContext | null> {
  try {
    const [status, baseBranch, remoteUrl] = await Promise.all([
      gitCli.status(repoRoot),
      gitCli.defaultBranch(repoRoot),
      gitCli.remoteUrl(repoRoot)
    ])

    const currentBranch = status.branch
    const onDefaultBranch = currentBranch === baseBranch

    let files: FileChange[] = []
    let aheadBy = 0
    let commits: CommitInfo[] | undefined
    if (!onDefaultBranch) {
      const baseRef = await resolveBaseRef(gitCli, repoRoot, baseBranch)
      const mergeBase = await gitCli.mergeBase(repoRoot, baseRef)
      if (mergeBase) {
        ;[files, aheadBy, commits] = await Promise.all([
          gitCli.branchDiffStat(repoRoot, mergeBase),
          gitCli.aheadCount(repoRoot, baseRef),
          gitCli.branchCommits(repoRoot, mergeBase, 50)
        ])
      }
    }

    // On default branch, show working tree changes instead
    if (onDefaultBranch) {
      const allChanges = [...status.staged, ...status.modified]
      const seen = new Set<string>()
      files = allChanges.filter((f) => {
        if (seen.has(f.path)) return false
        seen.add(f.path)
        return true
      })
    }

    const ctx: ThreadGitContext = {
      repoRoot,
      repoName: repoRoot.split('/').pop() ?? repoRoot,
      branch: currentBranch,
      baseBranch,
      aheadBy,
      files,
      ...(commits?.length ? { commits } : {})
    }

    // Parse remote + fetch PR info
    if (remoteUrl) {
      const remote = parseRemote(remoteUrl)
      if (remote) {
        ctx.remote = remote
        if (!onDefaultBranch) {
          const pr = await fetchGitHubPr(remote.owner, remote.repo, currentBranch)
          if (pr) ctx.pr = pr
        }
      }
    }

    return ctx
  } catch {
    return null
  }
}

export function createThreadGitRoutes(gitCli: GitCli, resolveRepos: ThreadRepoResolver): Router {
  const router = Router()

  // GET /api/threads/:threadId/git-context
  // Returns git context for all repos the thread's workspace contains.
  router.get('/api/threads/:threadId/git-context', async (req: Request, res: Response) => {
    const threadId = req.params.threadId
    const repoPaths = await resolveRepos(threadId)
    if (!repoPaths.length) {
      return res.json({ contexts: [] })
    }

    try {
      // Build context for each repo in parallel
      const results = await Promise.all(repoPaths.map((rp) => buildRepoContext(gitCli, rp)))
      const contexts = results.filter((c): c is ThreadGitContext => c !== null)
      res.json({ contexts })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // GET /api/threads/:threadId/diff?repo=<repoRoot>&file=<path>&commit=<hash>
  // Returns unified diff for a file, entire branch, or single commit.
  router.get('/api/threads/:threadId/diff', async (req: Request, res: Response) => {
    const threadId = req.params.threadId
    const repoRoot = (req.query.repo as string) || null
    const file = (req.query.file as string) || undefined
    const commit = (req.query.commit as string) || undefined
    const repoPaths = await resolveRepos(threadId)

    if (!repoPaths.length) {
      return res.status(404).json({ error: 'thread has no repos' })
    }

    const targetRepo = repoRoot || repoPaths[0]

    try {
      // Uncommitted changes — staged + unstaged vs HEAD
      if (commit === 'uncommitted') {
        const diff = await gitCli.uncommittedDiff(targetRepo, file)
        return res.json({ diff })
      }

      // Commit-scoped diff — show changes introduced by a single commit
      if (commit) {
        const diff = await gitCli.commitDiff(targetRepo, commit, file)
        return res.json({ diff })
      }

      const [baseBranch, status] = await Promise.all([gitCli.defaultBranch(targetRepo), gitCli.status(targetRepo)])
      const onDefaultBranch = status.branch === baseBranch

      let diff: string
      if (onDefaultBranch) {
        if (file) {
          diff = await gitCli.diff(targetRepo, file)
        } else {
          diff = await gitCli.branchDiff(targetRepo)
        }
      } else {
        const baseRef = await resolveBaseRef(gitCli, targetRepo, baseBranch)
        const mergeBase = await gitCli.mergeBase(targetRepo, baseRef)
        if (!mergeBase) {
          diff = file ? await gitCli.diff(targetRepo, file) : await gitCli.branchDiff(targetRepo)
        } else {
          diff = await gitCli.branchDiff(targetRepo, mergeBase, file)
        }
      }
      res.json({ diff })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  return router
}
