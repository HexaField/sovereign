/**
 * Indexing pipeline — takes files or raw text, chunks them, embeds them,
 * and stores them in the vector store.
 */

import crypto from 'node:crypto'
import { embedBatch, type EmbedOptions } from './embed.js'
import { chunkFile, chunkText, type ChunkOptions } from './chunker.js'
import type { VectorStore } from './store.js'

export interface IndexFileOptions {
  /** Collection name. Default: 'default'. */
  collection?: string
  /** Chunking options. */
  chunk?: ChunkOptions
  /** Embedding options. */
  embed?: EmbedOptions
  /** Max texts per embedding batch. Default: 32. */
  batchSize?: number
}

export interface IndexTextOptions extends IndexFileOptions {
  /** Source identifier for the text. */
  source: string
  /** Additional metadata to attach to each chunk. */
  metadata?: Record<string, unknown>
}

/** Generate a deterministic document ID from source + chunk index. */
function docId(source: string, chunkIndex: number): string {
  const hash = crypto.createHash('sha256').update(`${source}:${chunkIndex}`).digest('hex')
  return hash.slice(0, 16)
}

/** Index a file's contents into the vector store. */
export async function indexFile(
  store: VectorStore,
  filePath: string,
  content: string,
  opts: IndexFileOptions = {}
): Promise<{ chunksIndexed: number }> {
  const collection = opts.collection ?? 'default'
  const batchSize = opts.batchSize ?? 32

  const chunks = chunkFile(filePath, content, opts.chunk)
  if (chunks.length === 0) return { chunksIndexed: 0 }

  // Embed in batches
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const embeddings = await embedBatch(
      batch.map((c) => c.text),
      'search_document',
      opts.embed
    )

    const docs = batch.map((chunk, j) => ({
      id: docId(filePath, chunk.index),
      content: chunk.text,
      source: filePath,
      metadata: {
        chunkIndex: chunk.index,
        startChar: chunk.startChar,
        endChar: chunk.endChar
      },
      embedding: embeddings[j].embedding
    }))

    store.insertMany(collection, docs)
  }

  return { chunksIndexed: chunks.length }
}

/** Index raw text (not from a file) into the vector store. */
export async function indexText(
  store: VectorStore,
  text: string,
  opts: IndexTextOptions
): Promise<{ chunksIndexed: number }> {
  const collection = opts.collection ?? 'default'
  const batchSize = opts.batchSize ?? 32

  const chunks = chunkText(text, opts.chunk)
  if (chunks.length === 0) return { chunksIndexed: 0 }

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const embeddings = await embedBatch(
      batch.map((c) => c.text),
      'search_document',
      opts.embed
    )

    const docs = batch.map((chunk, j) => ({
      id: docId(opts.source, chunk.index),
      content: chunk.text,
      source: opts.source,
      metadata: {
        ...opts.metadata,
        chunkIndex: chunk.index,
        startChar: chunk.startChar,
        endChar: chunk.endChar
      },
      embedding: embeddings[j].embedding
    }))

    store.insertMany(collection, docs)
  }

  return { chunksIndexed: chunks.length }
}

/** Search the store using a natural language query. */
export async function search(
  store: VectorStore,
  query: string,
  opts: {
    collection?: string
    source?: string
    limit?: number
    embed?: EmbedOptions
  } = {}
): Promise<import('./store.js').SearchResult[]> {
  const { embedding } = await (await import('./embed.js')).embedText(query, 'search_query', opts.embed)
  return store.search(embedding, {
    collection: opts.collection,
    source: opts.source,
    limit: opts.limit
  })
}
