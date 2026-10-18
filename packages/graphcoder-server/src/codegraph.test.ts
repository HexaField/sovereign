import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { computeArchDiff, createMemberResolver } from '@sovereign/graphcoder-core'
import { hasCodegraphIndex, indexPath, openCodegraphIndex } from './codegraph.js'
import { cliStatus, hasCodegraphCli, indexedFixture } from './test-fixture.js'

let fixture: ReturnType<typeof indexedFixture> | undefined
afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

describe.skipIf(!hasCodegraphCli)('openCodegraphIndex against an index the codegraph CLI wrote', () => {
  it('reads the same counts the CLI reports', () => {
    fixture = indexedFixture()
    const handle = openCodegraphIndex(fixture.repo)
    try {
      const cli = cliStatus(fixture.repo)
      expect(handle.stats()).toEqual({
        nodeCount: cli.nodeCount,
        edgeCount: cli.edgeCount,
        fileCount: cli.fileCount,
        nodesByKind: cli.nodesByKind
      })
      expect(handle.stats()).toMatchObject({ fileCount: 3, nodesByKind: { class: 1, function: 2, method: 3 } })
      expect(handle.repoPath).toBe(fixture.repo)
    } finally {
      handle.close()
    }
  })

  it('reads the whole graph as a snapshot the core can diff and resolve against', () => {
    fixture = indexedFixture()
    const handle = openCodegraphIndex(fixture.repo)
    try {
      const snap = handle.snapshot()
      const stats = handle.stats()
      expect(snap.nodes).toHaveLength(stats.nodeCount)
      expect(snap.edges).toHaveLength(stats.edgeCount)
      expect(snap.nodes.find((n) => n.name === 'translate')).toMatchObject({
        kind: 'method',
        filePath: 'src/geometry.ts'
      })
      expect(snap.edges.some((e) => e.kind === 'calls')).toBe(true)
      expect(computeArchDiff(snap, handle.snapshot()).operations).toEqual([])
      // The fixture's committed annotation names `add` by semantic id; it resolves in the real index
      const add = createMemberResolver(snap.nodes)({
        id: '4ae16ad70c22ddc2b32ef528447306582fb5ab2804dd5cf2d933e4b2c6fae4e9',
        file: 'src/math.ts'
      })
      expect(add).toMatchObject({ kind: 'function', name: 'add' })
    } finally {
      handle.close()
    }
  })

  it('opens read-only: reading leaves the database file untouched', () => {
    fixture = indexedFixture()
    const db = indexPath(fixture.repo)
    const before = digest(db)
    const handle = openCodegraphIndex(fixture.repo)
    handle.stats()
    handle.snapshot()
    handle.close()
    handle.close() // idempotent
    expect(digest(db)).toBe(before)
  })

  it('refuses an index with another schema version', () => {
    fixture = indexedFixture()
    const db = new DatabaseSync(indexPath(fixture.repo))
    db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
      99,
      Date.now(),
      'future'
    )
    db.close()
    expect(() => openCodegraphIndex(fixture!.repo)).toThrow(/schema version 99.*Upgrade/)
  })
})

describe('openCodegraphIndex without an index', () => {
  it('says so', () => {
    expect(hasCodegraphIndex('/nonexistent/repo')).toBe(false)
    expect(() => openCodegraphIndex('/nonexistent/repo')).toThrow(/No CodeGraph index/)
  })
})
