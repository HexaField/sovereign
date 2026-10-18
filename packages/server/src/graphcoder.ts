// Sovereign's side of Graphcoder's ports. Graphcoder (packages/graphcoder-*)
// never imports Sovereign; this composition root hands it what it needs:
//
//   GraphSource ← the code index: every checkout under the org roots that has a
//                 codegraph index, kept fresh by code-index; opened read-only.
//   GitPort     ← @sovereign/git's CLI and @sovereign/worktrees' worktree
//                 commands. Checkouts are detached worktrees under
//                 <dataDir>/graphcoder/checkouts, never inside the user's repo.
//
// AiPort is not wired: nothing in Graphcoder calls a model yet. Removing
// packages/graphcoder-* takes this file and its one call in bootstrap.ts.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Express, NextFunction, Request, Response } from 'express'
import type { CodeIndex } from '@sovereign/code-index'
import { hasIndex } from '@sovereign/code-index'
import { createGitCli, type GitCli } from '@sovereign/git'
import type { Checkout, GitPort, GraphSource } from '@sovereign/graphcoder-core'
import { createGraphcoderRouter, createGraphcoderService, openCodegraphIndex } from '@sovereign/graphcoder-server'
import { worktreeAddDetached, worktreeRemove } from '@sovereign/worktrees'

const execFileAsync = promisify(execFile)

const isWithin = (root: string, p: string) => p === root || p.startsWith(root + path.sep)

/** The checkouts code-index tracks that have an index; only those open. */
export function createCodeIndexGraphSource(codeIndex: Pick<CodeIndex, 'status'>): GraphSource {
  const list = async () =>
    codeIndex
      .status()
      .roots.map((r) => r.root)
      .filter(hasIndex)
  return {
    list,
    open: async (repoPath) => {
      const repo = path.resolve(repoPath)
      if (!(await list()).includes(repo)) throw new Error(`Not an indexed checkout: ${repoPath}`)
      return openCodegraphIndex(repo)
    }
  }
}

/** A ref handed to git as an argument: never an option */
function assertRef(ref: string): void {
  if (ref === '' || ref.startsWith('-') || /\s/.test(ref)) throw new Error(`Not a git ref: ${JSON.stringify(ref)}`)
}

export interface SovereignGitPort extends GitPort {
  /** Removes checkouts a previous process left behind (a crash before `release`); resolves to how many */
  releaseLeftovers(): Promise<number>
}

export function createSovereignGitPort(git: GitCli, checkoutsDir: string): SovereignGitPort {
  const root = path.resolve(checkoutsDir)

  /** The main checkout a linked worktree belongs to */
  const mainRepoOf = async (worktree: string): Promise<string> => {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: worktree
    })
    return path.dirname(stdout.trim())
  }

  return {
    diffRefs: async (repoPath, base, head) => {
      assertRef(base)
      assertRef(head)
      const files = await git.branchDiffStat(repoPath, base, head)
      return files.map((f) => ({ path: f.path, status: f.status, ...(f.oldPath ? { oldPath: f.oldPath } : {}) }))
    },

    checkout: async (repoPath, ref): Promise<Checkout> => {
      assertRef(ref)
      const repo = path.resolve(repoPath)
      if (isWithin(repo, root)) throw new Error(`The checkout directory ${root} lies inside ${repo}; refusing`)
      fs.mkdirSync(root, { recursive: true })
      const dir = path.join(root, `${path.basename(repo)}-${randomUUID().slice(0, 8)}`)
      await worktreeAddDetached(repo, dir, ref)
      // Once released, release again is a no-op; a failed release may be retried
      let released: Promise<void> | undefined
      return {
        path: dir,
        release: () =>
          (released ??= worktreeRemove(repo, dir).catch((err) => {
            released = undefined
            throw err
          }))
      }
    },

    log: async (repoPath, opts = {}) => {
      if (opts.since) assertRef(opts.since)
      const commits = await git.log(repoPath, opts.limit ?? 50, { since: opts.since, paths: opts.paths })
      return commits.map((c) => ({ hash: c.hash, message: c.message, author: c.author, date: c.date }))
    },

    releaseLeftovers: async () => {
      if (!fs.existsSync(root)) return 0
      let released = 0
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name)
        try {
          await worktreeRemove(await mainRepoOf(dir), dir)
          released++
        } catch (err) {
          console.warn(`[graphcoder] could not release leftover checkout ${dir}: ${(err as Error).message}`)
        }
      }
      return released
    }
  }
}

export interface MountGraphcoderOptions {
  /** `graphcoder.enabled`, read at boot */
  enabled: boolean
  codeIndex: Pick<CodeIndex, 'status'>
  dataDir: string
  requireAuth: (req: Request, res: Response, next: NextFunction) => void
}

/** Mounts Graphcoder's routes over Sovereign's ports when enabled; off, mounts nothing. True when mounted. */
export function mountGraphcoder(app: Express, opts: MountGraphcoderOptions): boolean {
  if (!opts.enabled) return false
  const git = createSovereignGitPort(createGitCli(), path.join(opts.dataDir, 'graphcoder', 'checkouts'))
  git.releaseLeftovers().catch((err) => console.error('[graphcoder] leftover checkouts:', (err as Error).message))
  const service = createGraphcoderService({ graph: createCodeIndexGraphSource(opts.codeIndex), git })
  app.use(createGraphcoderRouter(service, opts.requireAuth))
  return true
}
