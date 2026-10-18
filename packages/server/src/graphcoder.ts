// Sovereign's side of Graphcoder's ports. Graphcoder (packages/graphcoder-*)
// never imports Sovereign; this composition root hands it what it needs:
//
//   GraphSource ← the code index: every checkout under the org roots that has a
//                 codegraph index, kept fresh by code-index; opened read-only.
//   GitPort     ← git (refs, merge bases, fetches, zero-context diffs) and
//                 @sovereign/worktrees' worktree commands. Checkouts are
//                 detached worktrees under <dataDir>/graphcoder/checkouts,
//                 never inside the user's repo.
//
// Structures of changes are cached under <dataDir>/graphcoder/structure.
// AiPort is not wired: nothing in Graphcoder calls a model yet. Removing
// packages/graphcoder-* takes this file, its call in bootstrap.ts and the
// `structureOf` the work graph gets from it.

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Express, NextFunction, Request, Response } from 'express'
import type { CodeIndex } from '@sovereign/code-index'
import { hasIndex } from '@sovereign/code-index'
import { createGitCli, type GitCli } from '@sovereign/git'
import { parseUnifiedDiff, type Checkout, type GitPort, type GraphSource } from '@sovereign/graphcoder-core'
import type { StructureOf } from '@sovereign/graphcoder-core/contract'
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

const FULL_SHA = /^[0-9a-f]{40}$/
const FETCH_TIMEOUT_MS = 120_000

/** git in `cwd`, stdout trimmed; never prompts for credentials */
async function run(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout.trim()
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

  const resolve = async (repoPath: string, ref: string): Promise<string | null> => {
    assertRef(ref)
    try {
      return await run(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
    } catch {
      return null
    }
  }

  return {
    resolve,

    mergeBase: async (repoPath, a, b) => {
      assertRef(a)
      assertRef(b)
      try {
        return await run(repoPath, ['merge-base', '--end-of-options', a, b])
      } catch {
        return null
      }
    },

    fetch: async (repoPath, refs) => {
      const remotes = (await run(repoPath, ['remote'])).split('\n').filter(Boolean)
      const fetchFrom = (remote: string, what: string) =>
        run(repoPath, ['fetch', '--no-tags', '--quiet', '--end-of-options', remote, what], FETCH_TIMEOUT_MS)
      for (const ref of refs) {
        assertRef(ref)
        const remote = remotes.find((r) => ref.startsWith(`${r}/`))
        // A branch fetched by name also moves its remote-tracking ref (the configured refspec covers it)
        if (remote) await fetchFrom(remote, ref.slice(remote.length + 1))
        else if (FULL_SHA.test(ref) && !(await resolve(repoPath, ref))) {
          let lastError: Error | undefined
          for (const r of remotes) {
            try {
              await fetchFrom(r, ref)
              if (await resolve(repoPath, ref)) break
            } catch (err) {
              lastError = err as Error
            }
          }
          if (!(await resolve(repoPath, ref))) throw lastError ?? new Error(`No remote of ${repoPath} has ${ref}`)
        }
      }
    },

    diffRefs: async (repoPath, base, head) => {
      assertRef(base)
      assertRef(head)
      return parseUnifiedDiff(
        await run(repoPath, [
          '-c',
          'core.quotePath=off',
          'diff',
          '-U0',
          '-M',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--end-of-options',
          `${base}...${head}`
        ])
      )
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
        switchTo: async (to) => {
          assertRef(to)
          await run(dir, ['checkout', '--quiet', '--detach', to])
        },
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

/**
 * Mounts Graphcoder's routes over Sovereign's ports when enabled; off, mounts nothing. Returns the structure of a
 * change for the work graph's PR cards (the Forge link), or undefined when off.
 */
export function mountGraphcoder(app: Express, opts: MountGraphcoderOptions): StructureOf | undefined {
  if (!opts.enabled) return undefined
  const dir = path.join(opts.dataDir, 'graphcoder')
  const git = createSovereignGitPort(createGitCli(), path.join(dir, 'checkouts'))
  git.releaseLeftovers().catch((err) => console.error('[graphcoder] leftover checkouts:', (err as Error).message))
  const service = createGraphcoderService(
    { graph: createCodeIndexGraphSource(opts.codeIndex), git },
    { cacheDir: path.join(dir, 'structure'), log: (msg) => console.log(`[graphcoder] ${msg}`) }
  )
  app.use(createGraphcoderRouter(service, opts.requireAuth))
  return (repoPath, base, head) => service.structureOf(repoPath, base, head)
}
