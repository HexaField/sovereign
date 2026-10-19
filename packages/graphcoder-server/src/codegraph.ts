// Read-only access to a checkout's CodeGraph index (`.codegraph/codegraph.db`).
//
// `CodeGraph.open` from codegraph's public API opens the database read-write
// and migrates an older schema in place (its `readOnly` option is accepted but
// unused). Graphcoder only reads, and the index belongs to whoever
// keeps it fresh (Sovereign's code-index, or the user's own `codegraph`), so
// this opens the SQLite file read-only through codegraph's own adapter and
// query builder. Both ship in codegraph's per-platform package, not its main
// entry, so they load by path: hence the exact version pin in package.json.
// An index whose schema version differs from the one this library reads is
// refused rather than misread.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { CodeGraphHandle, GraphEdge, GraphNode, GraphStats } from '@sovereign/graphcoder-core'

const require = createRequire(import.meta.url)

interface Db {
  close(): void
}

interface Queries {
  getStats(): GraphStats & Record<string, unknown>
  getAllNodes(): GraphNode[]
  getOutgoingEdges(nodeId: string): GraphEdge[]
}

interface Internals {
  createDatabase(dbPath: string, opts: { readOnly: boolean }): { db: Db }
  QueryBuilder: new (db: Db) => Queries
  getCurrentVersion(db: Db): number
  schemaVersion: number
}

let loaded: Internals | undefined

/** A file of codegraph's per-platform package, the one this reader is pinned to */
function platformFile(rel: string): string {
  const sdk = require.resolve('@colbymchenry/codegraph')
  return createRequire(sdk).resolve(`@colbymchenry/codegraph-${process.platform}-${process.arch}/${rel}`)
}

/**
 * The command that runs this codegraph version's CLI: its launcher, which starts the bundled Node with the flags it
 * needs. On Windows the bundled node.exe runs the entry directly, as codegraph's own npm shim does.
 */
export function codegraphCommand(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: platformFile('node.exe'), args: ['--liftoff-only', platformFile('lib/dist/bin/codegraph.js')] }
  }
  return { command: platformFile('bin/codegraph'), args: [] }
}

function internals(): Internals {
  if (loaded) return loaded
  const lib = platformFile('lib/dist/index.js')
  const dir = path.join(path.dirname(lib), 'db')
  const { createDatabase } = require(path.join(dir, 'sqlite-adapter.js'))
  const { QueryBuilder } = require(path.join(dir, 'queries.js'))
  const { getCurrentVersion, CURRENT_SCHEMA_VERSION } = require(path.join(dir, 'migrations.js'))
  loaded = { createDatabase, QueryBuilder, getCurrentVersion, schemaVersion: CURRENT_SCHEMA_VERSION }
  return loaded
}

export function indexPath(repoPath: string): string {
  return path.join(repoPath, '.codegraph', 'codegraph.db')
}

export function hasCodegraphIndex(repoPath: string): boolean {
  return fs.existsSync(indexPath(repoPath))
}

/** Opens a checkout's index read-only. Throws when there is none, or its schema is not the one this reader knows. */
export function openCodegraphIndex(repoPath: string): CodeGraphHandle {
  const root = path.resolve(repoPath)
  const file = indexPath(root)
  if (!fs.existsSync(file)) throw new Error(`No CodeGraph index at ${root} (run \`codegraph init\` there)`)
  const cg = internals()
  const { db } = cg.createDatabase(file, { readOnly: true })
  try {
    const version = cg.getCurrentVersion(db)
    if (version !== cg.schemaVersion) {
      throw new Error(
        `The index at ${root} has schema version ${version}; this reader knows ${cg.schemaVersion}. ` +
          (version < cg.schemaVersion
            ? 'Run `codegraph sync` there to migrate it.'
            : 'Upgrade @colbymchenry/codegraph.')
      )
    }
  } catch (err) {
    db.close()
    throw err
  }
  const queries = new cg.QueryBuilder(db)
  return {
    repoPath: root,
    stats: () => {
      const s = queries.getStats()
      return {
        nodeCount: s.nodeCount,
        edgeCount: s.edgeCount,
        fileCount: s.fileCount,
        nodesByKind: { ...s.nodesByKind }
      }
    },
    snapshot: () => {
      const nodes = queries.getAllNodes()
      return { nodes, edges: nodes.flatMap((n) => queries.getOutgoingEdges(n.id)) }
    },
    close: () => db.close()
  }
}
