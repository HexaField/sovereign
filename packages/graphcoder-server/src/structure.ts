// The structure of a change, computed on demand and cached on disk.
//
// One computation: resolve head and its merge base with base; diff them; check
// the merge base out into one temporary worktree and index it; move the same
// worktree to head and index again; read both indexes; compute; release the
// worktree. Neither side reuses the checkout's own index (see indexer.ts).
//
// Computations run one at a time, in arrival order; a request for a change
// already queued joins it. The result is cached per (checkout, merge base,
// head) in the cache directory the host passes, so a later request, and a
// restart, return it at once.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  computeChangeStructure,
  readPackages,
  type ChangeStructure,
  type GitPort,
  type StructureSide
} from '@sovereign/graphcoder-core'
import { openCodegraphIndex } from './codegraph.js'
import type { Indexer } from './indexer.js'
import { createNodeRepoFiles } from './repo-files.js'
import { readTestFiles } from './test-files.js'

/** Bump when the computation or the pinned codegraph changes what it returns: older cache entries are then recomputed (2: codegraph 1.6.2) */
export const STRUCTURE_VERSION = 2

export type CachedStructure =
  | { state: 'ready'; structure: ChangeStructure }
  | { state: 'computing' }
  | { state: 'failed'; error: string }
  | { state: 'none' }

export interface StructureStore {
  /** The structure of `head` against its merge base with `base`: from the cache, else computed (queued) */
  structureOf(repoPath: string, base: string, head: string): Promise<ChangeStructure>
  /** Only what is known now, without fetching or computing anything */
  cachedStructure(repoPath: string, base: string, head: string): Promise<CachedStructure>
}

export interface StructureStoreOptions {
  git: GitPort
  indexer: Indexer
  /** Where cached structures live; the host's choice */
  cacheDir: string
  log?: (msg: string) => void
}

interface Key {
  base: string
  head: string
}

/** A side of the change, read from a checkout whose index was just built */
async function readSide(dir: string): Promise<StructureSide> {
  const handle = openCodegraphIndex(dir)
  let snapshot
  try {
    snapshot = handle.snapshot()
  } finally {
    handle.close()
  }
  const files = createNodeRepoFiles(dir)
  const filePaths = snapshot.nodes.filter((n) => n.kind === 'file').map((n) => n.filePath)
  const [{ testFiles, testRanges }, packages] = await Promise.all([
    readTestFiles(files, snapshot.nodes),
    readPackages(files, filePaths)
  ])
  return { snapshot, testFiles, testRanges, packages }
}

export function createStructureStore(opts: StructureStoreOptions): StructureStore {
  const { git, indexer } = opts
  const log = opts.log ?? (() => undefined)
  const repoDir = (repo: string) =>
    path.join(opts.cacheDir, createHash('sha256').update(repo).digest('hex').slice(0, 16))
  const fileOf = (repo: string, k: Key) => path.join(repoDir(repo), `${k.base}..${k.head}.json`)

  const readCache = (repo: string, k: Key): ChangeStructure | undefined => {
    try {
      const entry = JSON.parse(fs.readFileSync(fileOf(repo, k), 'utf-8')) as {
        version: number
        repo: string
        structure: ChangeStructure
      }
      return entry.version === STRUCTURE_VERSION && entry.repo === repo ? entry.structure : undefined
    } catch {
      return undefined
    }
  }
  const writeCache = (repo: string, k: Key, structure: ChangeStructure) => {
    const file = fileOf(repo, k)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: STRUCTURE_VERSION, repo, structure }))
    fs.renameSync(tmp, file)
  }

  /** The shas a change names here, or null when the checkout lacks one */
  const resolveKey = async (repo: string, base: string, head: string): Promise<Key | null> => {
    const [b, h] = await Promise.all([git.resolve(repo, base), git.resolve(repo, head)])
    if (!b || !h) return null
    const mb = await git.mergeBase(repo, b, h)
    return mb ? { base: mb, head: h } : null
  }

  const compute = async (repo: string, k: Key): Promise<ChangeStructure> => {
    const files = await git.diffRefs(repo, k.base, k.head)
    if (files.length === 0) {
      const empty: StructureSide = {
        snapshot: { nodes: [], edges: [] },
        testFiles: [],
        testRanges: new Map(),
        packages: new Map()
      }
      return computeChangeStructure({ base: k.base, head: k.head, files, baseSide: empty, headSide: empty })
    }
    const started = Date.now()
    const checkout = await git.checkout(repo, k.base)
    try {
      await indexer.index(checkout.path)
      const baseSide = await readSide(checkout.path)
      await checkout.switchTo(k.head)
      await indexer.index(checkout.path)
      const headSide = await readSide(checkout.path)
      const structure = computeChangeStructure({ base: k.base, head: k.head, files, baseSide, headSide })
      log(`structure ${repo} ${k.base.slice(0, 8)}..${k.head.slice(0, 8)}: ${Date.now() - started} ms`)
      return structure
    } finally {
      await checkout.release()
    }
  }

  // One computation at a time; a request whose refs are already queued joins it
  let chain: Promise<unknown> = Promise.resolve()
  const queued = new Map<string, Promise<ChangeStructure>>()
  const failed = new Map<string, string>()
  const requestKey = (repo: string, base: string, head: string) => `${repo}\u0000${base}\u0000${head}`

  const enqueue = (repo: string, base: string, head: string): Promise<ChangeStructure> => {
    const rk = requestKey(repo, base, head)
    const held = queued.get(rk)
    if (held) return held
    failed.delete(rk)
    const job = chain.then(async () => {
      try {
        await git.fetch(repo, [base, head])
      } catch (err) {
        log(`fetch ${repo} ${base} ${head}: ${(err as Error).message}`)
      }
      const k = await resolveKey(repo, base, head)
      if (!k) throw new Error(`${repo} has no commit for ${[base, head].join(' or ')}, or they share no history`)
      const hit = readCache(repo, k)
      if (hit) return hit
      const structure = await compute(repo, k)
      writeCache(repo, k, structure)
      return structure
    })
    queued.set(rk, job)
    chain = job.catch(() => undefined)
    job.then(
      () => queued.delete(rk),
      (err: Error) => {
        queued.delete(rk)
        failed.set(rk, err.message)
      }
    )
    return job
  }

  return {
    structureOf: async (repo, base, head) => {
      const k = await resolveKey(repo, base, head)
      const hit = k && readCache(repo, k)
      return hit || enqueue(repo, base, head)
    },
    cachedStructure: async (repo, base, head) => {
      const k = await resolveKey(repo, base, head)
      const hit = k && readCache(repo, k)
      if (hit) return { state: 'ready', structure: hit }
      const rk = requestKey(repo, base, head)
      if (queued.has(rk)) return { state: 'computing' }
      const error = failed.get(rk)
      return error === undefined ? { state: 'none' } : { state: 'failed', error }
    }
  }
}
