// The concept map of a checkout at one commit: its concept tree mapped onto
// its code, with the scripted checks and the dependencies between concepts.
//
// The checkout's own HEAD is read in place, from its working tree and its
// own index (the host keeps that index fresh), so it is never cached: both
// move under it. Any other commit is checked out into a temporary worktree,
// indexed, read and released, one heavy job at a time (the queue the
// structure of a change uses); that result never changes, so it is cached per
// (checkout, commit, tree folder).

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  conceptDirOf,
  conceptMapReport,
  createConceptMap,
  createEdgeHygiene,
  type ConceptMapReport,
  type GitPort,
  type GraphSource,
  type StructureSide
} from '@sovereign/graphcoder-core'
import { openCodegraphIndex } from './codegraph.js'
import type { Indexer } from './indexer.js'
import type { SerialQueue } from './queue.js'
import { createNodeRepoFiles } from './repo-files.js'
import { readSide, takeSnapshot } from './side.js'

/** Bump when the report for a commit would come out different: cached reports are then recomputed */
export const CONCEPTS_VERSION = 1

/** The ref names no commit in the checkout */
export class UnknownRefError extends Error {
  constructor(repoPath: string, ref: string) {
    super(`${repoPath} has no commit ${ref}`)
  }
}

export interface ConceptStoreOptions {
  git: GitPort
  graph: GraphSource
  indexer: Indexer
  queue: SerialQueue
  /** Where reports of other commits are cached */
  cacheDir: string
  log?: (msg: string) => void
}

export interface ConceptStore {
  /** The concept map of `repoPath` at `ref` (default its HEAD). Rejects with `UnknownRefError` for an unknown ref. */
  conceptsOf(repoPath: string, ref?: string): Promise<ConceptMapReport>
}

/** The report of one side: an empty tree when it has none, so coverage still counts its files */
function report(repoPath: string, sha: string, dir: string, side: StructureSide): ConceptMapReport {
  const { nodes, edges } = side.snapshot
  const map = side.concepts ?? createConceptMap({ dir, pages: [] }, nodes)
  const hygiene = createEdgeHygiene(nodes, { packages: side.packages, testRanges: side.testRanges })
  return { path: repoPath, sha, ...conceptMapReport(map, nodes, edges, hygiene) }
}

export function createConceptStore(opts: ConceptStoreOptions): ConceptStore {
  const { git, graph, indexer } = opts
  const log = opts.log ?? (() => undefined)
  const fileOf = (repo: string, sha: string) =>
    path.join(opts.cacheDir, createHash('sha256').update(repo).digest('hex').slice(0, 16), `${sha}.json`)

  const readCache = (repo: string, sha: string, dir: string): ConceptMapReport | undefined => {
    try {
      const entry = JSON.parse(fs.readFileSync(fileOf(repo, sha), 'utf-8')) as {
        version: number
        repo: string
        report: ConceptMapReport
      }
      const ok = entry.version === CONCEPTS_VERSION && entry.repo === repo && entry.report.dir === dir
      return ok ? entry.report : undefined
    } catch {
      return undefined
    }
  }
  const writeCache = (repo: string, sha: string, value: ConceptMapReport) => {
    const file = fileOf(repo, sha)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: CONCEPTS_VERSION, repo, report: value }))
    fs.renameSync(tmp, file)
  }

  const atCommit = async (repo: string, sha: string, dir: string): Promise<ConceptMapReport> => {
    const started = Date.now()
    const checkout = await git.checkout(repo, sha)
    try {
      await indexer.index(checkout.path)
      const side = await readSide(checkout.path, takeSnapshot(openCodegraphIndex(checkout.path)), dir)
      log(`concepts ${repo} ${sha.slice(0, 8)}: ${Date.now() - started} ms`)
      return report(repo, sha, dir, side)
    } finally {
      await checkout.release()
    }
  }

  // A request for a commit already being read joins it
  const pending = new Map<string, Promise<ConceptMapReport>>()

  return {
    conceptsOf: async (repo, ref) => {
      const [current, sha] = await Promise.all([git.resolve(repo, 'HEAD'), ref ? git.resolve(repo, ref) : undefined])
      const wanted = ref ? sha : current
      if (!wanted) throw new UnknownRefError(repo, ref ?? 'HEAD')
      const dir = await conceptDirOf(createNodeRepoFiles(repo))
      if (wanted === current) {
        const side = await readSide(repo, takeSnapshot(await graph.open(repo)), dir)
        return report(repo, wanted, dir, side)
      }
      const hit = readCache(repo, wanted, dir)
      if (hit) return hit
      const key = `${repo}\u0000${wanted}\u0000${dir}`
      let job = pending.get(key)
      if (!job) {
        job = opts.queue
          .run(async () => {
            const value = readCache(repo, wanted, dir) ?? (await atCommit(repo, wanted, dir))
            writeCache(repo, wanted, value)
            return value
          })
          .finally(() => pending.delete(key))
        pending.set(key, job)
      }
      return job
    }
  }
}
