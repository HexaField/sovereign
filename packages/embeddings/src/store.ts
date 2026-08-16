/**
 * Vector store backed by node:sqlite + sqlite-vec.
 * Each collection holds documents with metadata and their embedding vectors.
 * All data stays on disk at the configured path — nothing leaves the machine.
 *
 * Uses Node's built-in SQLite (node:sqlite, available since Node 22.5)
 * to avoid native binding compilation issues.
 */

import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'

// sqlite-vec uses optional platform-specific native deps. Under pnpm's strict
// hoisting, the ESM import resolves from the repo root (where vitest runs) but
// the native bindings only appear inside the package's own node_modules.
// createRequire anchored to this file resolves through the local tree reliably.
const require = createRequire(import.meta.url)
const sqliteVec = require('sqlite-vec') as { getLoadablePath: () => string; load: (db: unknown) => void }

export interface Document {
  /** Unique document ID (caller-assigned or auto-generated). */
  id: string
  /** The raw text content. */
  content: string
  /** Source identifier (file path, URL, entity type, etc.). */
  source: string
  /** Arbitrary JSON metadata. */
  metadata?: Record<string, unknown>
  /** Pre-computed embedding vector. If omitted, caller must embed before insert. */
  embedding?: number[]
}

export interface SearchResult {
  id: string
  content: string
  source: string
  metadata: Record<string, unknown>
  distance: number
  score: number
}

export interface StoreOptions {
  /** Path to the SQLite database file. */
  dbPath: string
  /** Embedding dimensions. Default: 768 (nomic-embed-text-v1.5). */
  dimensions?: number
}

export class VectorStore {
  private db: DatabaseSync
  private dimensions: number

  constructor(opts: StoreOptions) {
    this.dimensions = opts.dimensions ?? 768
    this.db = new DatabaseSync(opts.dbPath, { allowExtension: true })

    // Load sqlite-vec extension
    this.db.loadExtension(sqliteVec.getLoadablePath())

    // Enable WAL for concurrent reads during writes
    this.db.exec('PRAGMA journal_mode = WAL')

    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        collection TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT DEFAULT '{}',
        chunk_index INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_documents_collection
        ON documents(collection);

      CREATE INDEX IF NOT EXISTS idx_documents_source
        ON documents(source);
    `)

    // vec0 virtual tables can't use IF NOT EXISTS — catch the error
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE vec_documents USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}]
        )`
      )
    } catch (err) {
      // Table already exists — ignore
      if (!(err instanceof Error) || !err.message.includes('already exists')) {
        throw err
      }
    }
  }

  /** Insert a document with its embedding into a collection. */
  insert(collection: string, doc: Document): void {
    if (!doc.embedding || doc.embedding.length !== this.dimensions) {
      throw new Error(`Embedding required with ${this.dimensions} dimensions, got ${doc.embedding?.length ?? 0}`)
    }

    const insertDoc = this.db.prepare(`
      INSERT OR REPLACE INTO documents (id, collection, content, source, metadata, chunk_index, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `)

    const deleteVec = this.db.prepare('DELETE FROM vec_documents WHERE id = ?')
    const insertVec = this.db.prepare(`
      INSERT INTO vec_documents (id, embedding)
      VALUES (?, ?)
    `)

    // node:sqlite doesn't have a transaction() helper — use exec
    this.db.exec('BEGIN')
    try {
      insertDoc.run(
        doc.id,
        collection,
        doc.content,
        doc.source,
        JSON.stringify(doc.metadata ?? {}),
        (doc.metadata?.chunkIndex as number) ?? 0
      )
      // vec0 virtual tables don't support INSERT OR REPLACE — delete first
      deleteVec.run(doc.id)
      insertVec.run(doc.id, new Uint8Array(new Float32Array(doc.embedding).buffer))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Batch insert documents. Runs in a single transaction for speed. */
  insertMany(collection: string, docs: Document[]): void {
    const insertDoc = this.db.prepare(`
      INSERT OR REPLACE INTO documents (id, collection, content, source, metadata, chunk_index, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `)

    const deleteVec = this.db.prepare('DELETE FROM vec_documents WHERE id = ?')
    const insertVec = this.db.prepare(`
      INSERT INTO vec_documents (id, embedding)
      VALUES (?, ?)
    `)

    this.db.exec('BEGIN')
    try {
      for (const doc of docs) {
        if (!doc.embedding || doc.embedding.length !== this.dimensions) {
          throw new Error(`Document ${doc.id}: embedding required with ${this.dimensions} dimensions`)
        }
        insertDoc.run(
          doc.id,
          collection,
          doc.content,
          doc.source,
          JSON.stringify(doc.metadata ?? {}),
          (doc.metadata?.chunkIndex as number) ?? 0
        )
        deleteVec.run(doc.id)
        insertVec.run(doc.id, new Uint8Array(new Float32Array(doc.embedding).buffer))
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Search for similar documents by embedding vector.
   * Returns results ordered by distance (ascending — closest first).
   */
  search(
    queryEmbedding: number[],
    opts: {
      collection?: string
      source?: string
      limit?: number
    } = {}
  ): SearchResult[] {
    const limit = opts.limit ?? 10

    // sqlite-vec KNN query — fetch extra to allow for post-filtering
    const vecStmt = this.db.prepare(`
      SELECT id, distance
      FROM vec_documents
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `)
    const vecResults = vecStmt.all(new Uint8Array(new Float32Array(queryEmbedding).buffer), limit * 3) as Array<{
      id: string
      distance: number
    }>

    if (vecResults.length === 0) return []

    // Fetch document metadata for matched IDs, applying collection/source filters
    const placeholders = vecResults.map(() => '?').join(',')
    let filterClause = `id IN (${placeholders})`
    const params: unknown[] = vecResults.map((r) => r.id)

    if (opts.collection) {
      filterClause += ' AND collection = ?'
      params.push(opts.collection)
    }
    if (opts.source) {
      filterClause += ' AND source = ?'
      params.push(opts.source)
    }

    const docStmt = this.db.prepare(`SELECT id, content, source, metadata FROM documents WHERE ${filterClause}`)
    const docs = docStmt.all(...params) as Array<{
      id: string
      content: string
      source: string
      metadata: string
    }>

    const docMap = new Map(docs.map((d) => [d.id, d]))

    const results: SearchResult[] = []
    for (const vr of vecResults) {
      const doc = docMap.get(vr.id)
      if (!doc) continue // filtered out by collection/source
      results.push({
        id: vr.id,
        content: doc.content,
        source: doc.source,
        metadata: JSON.parse(doc.metadata),
        distance: vr.distance,
        // Cosine similarity: distance from sqlite-vec cosine = 1 - similarity
        score: 1 - vr.distance
      })
    }

    return results.slice(0, limit)
  }

  /** Delete a document by ID. */
  delete(id: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM documents WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM vec_documents WHERE id = ?').run(id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Delete all documents in a collection. */
  deleteCollection(collection: string): void {
    const ids = this.db.prepare('SELECT id FROM documents WHERE collection = ?').all(collection) as Array<{
      id: string
    }>

    if (ids.length === 0) return

    this.db.exec('BEGIN')
    try {
      for (const { id } of ids) {
        this.db.prepare('DELETE FROM vec_documents WHERE id = ?').run(id)
      }
      this.db.prepare('DELETE FROM documents WHERE collection = ?').run(collection)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** List all collections with document counts. */
  listCollections(): Array<{ collection: string; count: number }> {
    return this.db
      .prepare('SELECT collection, COUNT(*) as count FROM documents GROUP BY collection ORDER BY collection')
      .all() as Array<{ collection: string; count: number }>
  }

  /** Count documents in a collection (or all if omitted). */
  count(collection?: string): number {
    if (collection) {
      const row = this.db.prepare('SELECT COUNT(*) as n FROM documents WHERE collection = ?').get(collection) as {
        n: number
      }
      return row.n
    }
    const row = this.db.prepare('SELECT COUNT(*) as n FROM documents').get() as { n: number }
    return row.n
  }

  /** Get a document by ID. */
  get(id: string): Omit<Document, 'embedding'> | null {
    const row = this.db.prepare('SELECT id, content, source, metadata FROM documents WHERE id = ?').get(id) as
      | { id: string; content: string; source: string; metadata: string }
      | undefined
    if (!row) return null
    return {
      id: row.id,
      content: row.content,
      source: row.source,
      metadata: JSON.parse(row.metadata)
    }
  }

  /** Close the database connection. */
  close(): void {
    this.db.close()
  }
}
