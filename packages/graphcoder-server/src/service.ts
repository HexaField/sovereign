// The Graphcoder service: what the routes (and, later, agent tools) call. It
// reaches checkouts only through the host's ports, and only checkouts the
// GraphSource lists: a caller can never point it at an arbitrary path.

import path from 'node:path'
import {
  loadAllAnnotations,
  type ChangeStructure,
  type ConceptMapReport,
  type GitPort,
  type GraphSource,
  type GraphStats
} from '@sovereign/graphcoder-core'
import { createConceptStore } from './concepts.js'
import { createCodegraphIndexer, type Indexer } from './indexer.js'
import { createSerialQueue } from './queue.js'
import { createNodeRepoFiles } from './repo-files.js'
import { createStructureStore, type CachedStructure } from './structure.js'

export interface GraphcoderPorts {
  graph: GraphSource
  git: GitPort
}

export interface GraphcoderOptions {
  /** Graphcoder's cache: a directory the host owns. Structures of changes go to `structure/`, concept maps to `concepts/` */
  cacheDir: string
  /** Builds the index of a temporary checkout; default the pinned codegraph CLI at low priority */
  indexer?: Indexer
  log?: (msg: string) => void
}

export interface GraphcoderStatus {
  enabled: true
  /** Checkouts with an index, absolute paths */
  repos: string[]
}

export interface RepoStats extends GraphStats {
  path: string
  /** Annotations committed under `.graphcoder/annotations/` */
  annotations: number
}

/** The path is not one of the checkouts the GraphSource lists */
export class UnknownRepoError extends Error {
  readonly repoPath: string
  constructor(repoPath: string) {
    super(`Not an indexed checkout: ${repoPath}`)
    this.repoPath = repoPath
  }
}

export interface GraphcoderService {
  readonly ports: GraphcoderPorts
  status(): Promise<GraphcoderStatus>
  /** Counts from the checkout's index and its `.graphcoder/` data. Rejects with `UnknownRepoError` for an unlisted path. */
  repoStats(repoPath: string): Promise<RepoStats>
  /**
   * What `head` changes against its merge base with `base`, in a listed checkout: cached, else computed (one at a
   * time, at low priority; refs the checkout lacks are fetched first). Rejects with `UnknownRepoError` for an
   * unlisted path.
   */
  structureOf(repoPath: string, base: string, head: string): Promise<ChangeStructure>
  /** The structure if it is cached, or whether it is being computed or failed; never computes or fetches */
  cachedStructure(repoPath: string, base: string, head: string): Promise<CachedStructure>
  /**
   * The concept map of a listed checkout at `ref` (default its HEAD, read in place): tree, code → concept map,
   * checks, dependencies. Another commit is read from a temporary worktree and cached. Rejects with
   * `UnknownRepoError` for an unlisted path, `UnknownRefError` for a ref the checkout lacks.
   */
  concepts(repoPath: string, ref?: string): Promise<ConceptMapReport>
}

export function createGraphcoderService(ports: GraphcoderPorts, options: GraphcoderOptions): GraphcoderService {
  const listed = async (repoPath: string): Promise<string> => {
    const wanted = path.resolve(repoPath)
    const repos = await ports.graph.list()
    if (!repos.includes(wanted)) throw new UnknownRepoError(repoPath)
    return wanted
  }
  const indexer = options.indexer ?? createCodegraphIndexer()
  // One checkout and index at a time, whichever store asks
  const queue = createSerialQueue()
  const structures = createStructureStore({
    git: ports.git,
    indexer,
    queue,
    cacheDir: path.join(options.cacheDir, 'structure'),
    log: options.log
  })
  const concepts = createConceptStore({
    git: ports.git,
    graph: ports.graph,
    indexer,
    queue,
    cacheDir: path.join(options.cacheDir, 'concepts'),
    log: options.log
  })

  return {
    ports,
    status: async () => ({ enabled: true, repos: [...(await ports.graph.list())].sort() }),
    repoStats: async (repoPath) => {
      const repo = await listed(repoPath)
      const handle = await ports.graph.open(repo)
      let stats: GraphStats
      try {
        stats = handle.stats()
      } finally {
        handle.close()
      }
      const annotations = await loadAllAnnotations(createNodeRepoFiles(repo))
      return { path: repo, ...stats, annotations: annotations.length }
    },
    structureOf: async (repoPath, base, head) => structures.structureOf(await listed(repoPath), base, head),
    cachedStructure: async (repoPath, base, head) => structures.cachedStructure(await listed(repoPath), base, head),
    concepts: async (repoPath, ref) => concepts.conceptsOf(await listed(repoPath), ref)
  }
}
