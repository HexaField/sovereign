// Embeddings service — wraps @sovereign/embeddings into the EmbeddingsToolDeps
// interface consumed by both the Claude Code MCP server and the local-llm backend.
//
// Initialises lazily: the VectorStore opens on first use, and the embedding
// server health is checked at that point. All data stays on disk at
// `{dataDir}/embeddings.db` — nothing leaves the machine.

import path from 'node:path'
import type { EmbeddingsToolDeps } from './claude-code/mcp-server.js'

// Dynamic import — @sovereign/embeddings may not exist in all builds.
// The caller checks availability before wiring this service.
type EmbeddingsModule = typeof import('@sovereign/embeddings')

export interface EmbeddingsServiceOpts {
  /** Sovereign data directory — the SQLite db lives at `{dataDir}/embeddings.db`. */
  dataDir: string
  /** Embedding server base URL. Default: http://127.0.0.1:9092 */
  baseUrl?: string
}

export function createEmbeddingsService(opts: EmbeddingsServiceOpts): EmbeddingsToolDeps {
  const dbPath = path.join(opts.dataDir, 'embeddings.db')
  const baseUrl = opts.baseUrl ?? 'http://127.0.0.1:9092'

  // Lazy singleton — avoids opening the db on startup when embeddings
  // tools may never get called.
  let mod: EmbeddingsModule | null = null
  let store: InstanceType<EmbeddingsModule['VectorStore']> | null = null

  async function ensureReady(): Promise<{
    mod: EmbeddingsModule
    store: InstanceType<EmbeddingsModule['VectorStore']>
  }> {
    if (mod && store) return { mod, store }
    mod = await import('@sovereign/embeddings')
    store = new mod.VectorStore({ dbPath })
    return { mod, store }
  }

  return {
    async search(query, searchOpts = {}) {
      const { mod: m, store: s } = await ensureReady()
      const results = await m.search(s, query, {
        collection: searchOpts.collection,
        source: searchOpts.source,
        limit: searchOpts.limit,
        embed: { baseUrl }
      })
      return results.map((r) => ({
        content: r.content,
        source: r.source,
        score: r.score,
        metadata: r.metadata
      }))
    },

    async index(content, indexOpts) {
      const { mod: m, store: s } = await ensureReady()
      return m.indexText(s, content, {
        source: indexOpts.source,
        collection: indexOpts.collection ?? 'default',
        embed: { baseUrl }
      })
    },

    listCollections() {
      if (!store) return []
      return store.listCollections()
    },

    async healthy() {
      if (!mod) {
        try {
          mod = await import('@sovereign/embeddings')
        } catch {
          return false
        }
      }
      return mod.embedHealthCheck(baseUrl)
    }
  }
}
