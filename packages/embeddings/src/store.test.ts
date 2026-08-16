import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { VectorStore } from './store.js'

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-vec-'))
  return path.join(dir, 'test.db')
}

function randomEmbedding(dims = 768): number[] {
  const vec = Array.from({ length: dims }, () => Math.random() - 0.5)
  // L2-normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  return vec.map((v) => v / norm)
}

describe('VectorStore', () => {
  let store: VectorStore
  let dbPath: string

  beforeEach(() => {
    dbPath = tmpDb()
    store = new VectorStore({ dbPath })
  })

  afterEach(() => {
    store.close()
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true })
  })

  it('inserts and retrieves a document', () => {
    const emb = randomEmbedding()
    store.insert('test', {
      id: 'doc1',
      content: 'Hello world',
      source: 'test.txt',
      embedding: emb
    })

    const doc = store.get('doc1')
    expect(doc).not.toBeNull()
    expect(doc!.content).toBe('Hello world')
    expect(doc!.source).toBe('test.txt')
  })

  it('searches by vector similarity', () => {
    const emb1 = randomEmbedding()
    const emb2 = randomEmbedding()

    store.insert('test', {
      id: 'doc1',
      content: 'Document one',
      source: 'a.txt',
      embedding: emb1
    })

    store.insert('test', {
      id: 'doc2',
      content: 'Document two',
      source: 'b.txt',
      embedding: emb2
    })

    // Search with emb1 — doc1 should rank first
    const results = store.search(emb1, { limit: 2 })
    expect(results.length).toBe(2)
    expect(results[0].id).toBe('doc1')
    expect(results[0].distance).toBeLessThan(results[1].distance)
  })

  it('filters by collection', () => {
    const emb = randomEmbedding()
    store.insert('coll-a', {
      id: 'doc1',
      content: 'In collection A',
      source: 'a.txt',
      embedding: emb
    })
    store.insert('coll-b', {
      id: 'doc2',
      content: 'In collection B',
      source: 'b.txt',
      embedding: randomEmbedding()
    })

    const results = store.search(emb, { collection: 'coll-a', limit: 10 })
    expect(results.every((r) => r.source === 'a.txt')).toBe(true)
  })

  it('batch inserts documents', () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({
      id: `doc${i}`,
      content: `Document number ${i}`,
      source: 'batch.txt',
      embedding: randomEmbedding()
    }))

    store.insertMany('batch', docs)
    expect(store.count('batch')).toBe(50)
  })

  it('deletes a document', () => {
    store.insert('test', {
      id: 'doc1',
      content: 'To delete',
      source: 'x.txt',
      embedding: randomEmbedding()
    })

    expect(store.get('doc1')).not.toBeNull()
    store.delete('doc1')
    expect(store.get('doc1')).toBeNull()
  })

  it('deletes a collection', () => {
    for (let i = 0; i < 5; i++) {
      store.insert('to-delete', {
        id: `d${i}`,
        content: `Doc ${i}`,
        source: 'x.txt',
        embedding: randomEmbedding()
      })
    }

    expect(store.count('to-delete')).toBe(5)
    store.deleteCollection('to-delete')
    expect(store.count('to-delete')).toBe(0)
  })

  it('lists collections with counts', () => {
    store.insert('alpha', { id: 'a1', content: 'x', source: 's', embedding: randomEmbedding() })
    store.insert('alpha', { id: 'a2', content: 'y', source: 's', embedding: randomEmbedding() })
    store.insert('beta', { id: 'b1', content: 'z', source: 's', embedding: randomEmbedding() })

    const colls = store.listCollections()
    expect(colls).toContainEqual({ collection: 'alpha', count: 2 })
    expect(colls).toContainEqual({ collection: 'beta', count: 1 })
  })

  it('rejects embeddings with wrong dimensions', () => {
    expect(() =>
      store.insert('test', {
        id: 'bad',
        content: 'x',
        source: 's',
        embedding: [1, 2, 3] // wrong dimensions
      })
    ).toThrow(/768 dimensions/)
  })

  it('upserts on duplicate ID', () => {
    const emb = randomEmbedding()
    store.insert('test', { id: 'dup', content: 'v1', source: 's', embedding: emb })
    store.insert('test', { id: 'dup', content: 'v2', source: 's', embedding: emb })

    const doc = store.get('dup')
    expect(doc!.content).toBe('v2')
    expect(store.count('test')).toBe(1)
  })
})
