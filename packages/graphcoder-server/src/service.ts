// The Graphcoder service: what the routes (and, later, agent tools) call. It
// reaches checkouts only through the host's ports, and only checkouts the
// GraphSource lists: a caller can never point it at an arbitrary path.

import path from 'node:path'
import { loadAllAnnotations, type GitPort, type GraphSource, type GraphStats } from '@sovereign/graphcoder-core'
import { createNodeRepoFiles } from './repo-files.js'

export interface GraphcoderPorts {
  graph: GraphSource
  /** Used from P1 on (the structure of a change); the host supplies it with the others */
  git: GitPort
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
}

export function createGraphcoderService(ports: GraphcoderPorts): GraphcoderService {
  const listed = async (repoPath: string): Promise<string> => {
    const wanted = path.resolve(repoPath)
    const repos = await ports.graph.list()
    if (!repos.includes(wanted)) throw new UnknownRepoError(repoPath)
    return wanted
  }

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
    }
  }
}
