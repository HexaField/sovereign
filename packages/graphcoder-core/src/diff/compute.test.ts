import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../graph.js'
import { nodeSemanticId } from '../identity.js'
import { makeEdge, makeNode } from './fixtures.js'
import { computeArchDiff, sortOps } from './compute.js'
import { canonicalJson, computeDiffHash, snapshotHash } from './hash.js'
import type { ArchOp } from './types.js'

describe('computeArchDiff', () => {
  it('returns empty diff for identical snapshots', () => {
    const snap: GraphSnapshot = { nodes: [makeNode('n1', 'foo')], edges: [] }
    const diff = computeArchDiff(snap, snap)
    expect(diff.version).toBe(2)
    expect(diff.operations).toHaveLength(0)
    expect(diff.base).toBe(diff.target)
  })

  it('detects an added node, named by its semantic id', () => {
    const foo = makeNode('n1', 'foo')
    const diff = computeArchDiff({ nodes: [], edges: [] }, { nodes: [foo], edges: [] })
    expect(diff.operations).toEqual([
      { op: 'add_node', node: expect.objectContaining({ id: nodeSemanticId(foo), name: 'foo', filePath: 'src/a.ts' }) }
    ])
  })

  it('detects a removed node and carries its content', () => {
    const foo = makeNode('n1', 'foo')
    const diff = computeArchDiff({ nodes: [foo], edges: [] }, { nodes: [], edges: [] })
    expect(diff.operations).toEqual([
      { op: 'remove_node', id: nodeSemanticId(foo), node: expect.objectContaining({ name: 'foo' }) }
    ])
  })

  it('detects a move (same semantic ID, different filePath)', () => {
    const base: GraphSnapshot = { nodes: [makeNode('n1', 'add', 'function', 'src/math.ts')], edges: [] }
    const target: GraphSnapshot = { nodes: [makeNode('n2', 'add', 'function', 'src/arithmetic.ts')], edges: [] }
    expect(computeArchDiff(base, target).operations).toEqual([
      {
        op: 'move_node',
        id: nodeSemanticId(base.nodes[0]),
        from: { filePath: 'src/math.ts' },
        to: { filePath: 'src/arithmetic.ts' }
      }
    ])
  })

  it('detects a modification (visibility changed), and a move with it is a modification', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'function', 'src/a.ts', { visibility: 'private' })],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'function', 'src/b.ts', { visibility: 'public' })],
      edges: []
    }
    expect(computeArchDiff(base, target).operations).toEqual([
      {
        op: 'modify_node',
        id: nodeSemanticId(base.nodes[0]),
        prev: { filePath: 'src/a.ts', visibility: 'private' },
        next: { filePath: 'src/b.ts', visibility: 'public' }
      }
    ])
  })

  it('compares decorators and type parameters by value', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'class', 'src/a.ts', { decorators: ['a'] })],
      edges: []
    }
    const same: GraphSnapshot = {
      nodes: [makeNode('n9', 'foo', 'class', 'src/a.ts', { decorators: ['a'] })],
      edges: []
    }
    expect(computeArchDiff(base, same).operations).toEqual([])
    const changed: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo', 'class', 'src/a.ts', { decorators: ['a', 'b'] })],
      edges: []
    }
    expect(computeArchDiff(base, changed).operations.map((o) => o.op)).toEqual(['modify_node'])
  })

  it('annotates probable renames with renameOf hint', () => {
    const subtract = makeNode('n1', 'subtract', 'function', 'src/math.ts', { startLine: 3, endLine: 5 })
    const minus = makeNode('n2', 'minus', 'function', 'src/math.ts', { startLine: 3, endLine: 5 })
    const far = makeNode('n3', 'far', 'function', 'src/math.ts', { startLine: 30, endLine: 35 })
    const diff = computeArchDiff({ nodes: [subtract], edges: [] }, { nodes: [minus, far], edges: [] })
    const added = diff.operations.flatMap((o) => (o.op === 'add_node' ? [o.node] : []))
    expect(added.find((n) => n.name === 'minus')?.properties).toEqual({ renameOf: nodeSemanticId(subtract) })
    expect(added.find((n) => n.name === 'far')?.properties).toBeUndefined()
  })

  it('detects added and removed edges by semantic triple, ignoring CodeGraph ids', () => {
    const n1 = makeNode('n1', 'foo')
    const n2 = makeNode('n2', 'bar')
    const base: GraphSnapshot = { nodes: [n1, n2], edges: [] }
    const target: GraphSnapshot = { nodes: [n1, n2], edges: [makeEdge('n1', 'n2')] }
    const added = computeArchDiff(base, target).operations
    expect(added).toEqual([
      { op: 'add_edge', edge: { source: nodeSemanticId(n1), target: nodeSemanticId(n2), kind: 'calls', metadata: {} } }
    ])
    expect(computeArchDiff(target, base).operations).toEqual([
      { op: 'remove_edge', edge: { source: nodeSemanticId(n1), target: nodeSemanticId(n2), kind: 'calls' } }
    ])
    // The same code under other CodeGraph ids (a re-index after a move) has the same edges
    const renumbered: GraphSnapshot = {
      nodes: [
        { ...n1, id: 'x1' },
        { ...n2, id: 'x2' }
      ],
      edges: [makeEdge('x1', 'x2')]
    }
    expect(computeArchDiff(target, renumbered).operations).toEqual([])
  })

  it('gives an added edge the resolver metadata and line of its best-resolved instance', () => {
    const a = makeNode('n1', 'foo')
    const b = makeNode('n2', 'bar')
    const c = makeNode('n3', 'baz')
    // the same semantic edge twice (two call sites), and an edge the indexer gave no metadata
    const target: GraphSnapshot = {
      nodes: [a, b, c],
      edges: [
        { source: 'n1', target: 'n2', kind: 'calls', line: 3, metadata: { confidence: 0.4, resolvedBy: 'fuzzy' } },
        { source: 'n1', target: 'n2', kind: 'calls', line: 9, metadata: { confidence: 0.95, resolvedBy: 'import' } },
        { source: 'n1', target: 'n3', kind: 'imports' }
      ]
    }
    const diff = computeArchDiff({ nodes: [a, b, c], edges: [] }, target)
    const added = diff.operations.flatMap((o) => (o.op === 'add_edge' ? [o.edge] : []))
    const byKind = (x: { kind: string }, y: { kind: string }) => (x.kind < y.kind ? -1 : 1)
    expect(added.sort(byKind).map((e) => [e.kind, e.metadata, e.line])).toEqual([
      ['calls', { confidence: 0.95, resolvedBy: 'import' }, 9],
      ['imports', {}, undefined]
    ])
  })

  it('drops edges whose ends are not in the snapshot', () => {
    const n1 = makeNode('n1', 'foo')
    const diff = computeArchDiff({ nodes: [n1], edges: [] }, { nodes: [n1], edges: [makeEdge('n1', 'ghost')] })
    expect(diff.operations).toEqual([])
  })

  it('produces canonical ordering (removes before adds)', () => {
    const base: GraphSnapshot = {
      nodes: [makeNode('n1', 'foo'), makeNode('n4', 'keep', 'function', 'src/k.ts')],
      edges: []
    }
    const target: GraphSnapshot = {
      nodes: [makeNode('n2', 'bar'), makeNode('n3', 'baz'), makeNode('n4', 'keep', 'function', 'src/moved.ts')],
      edges: [makeEdge('n2', 'n3')]
    }
    const ops = computeArchDiff(base, target).operations.map((o) => o.op)
    expect(ops).toEqual(['remove_node', 'move_node', 'add_node', 'add_node', 'add_edge'])
    expect(sortOps([...computeArchDiff(base, target).operations].reverse())).toEqual(
      computeArchDiff(base, target).operations
    )
  })

  it('gives the same diff and diffHash whatever order the snapshots list things in', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((n, i) => makeNode(`n${i}`, n))
    const edges = [makeEdge('n0', 'n1'), makeEdge('n1', 'n2'), makeEdge('n2', 'n3')]
    const base: GraphSnapshot = { nodes: nodes.slice(0, 3), edges: edges.slice(0, 1) }
    const target: GraphSnapshot = { nodes, edges }
    const shuffled: GraphSnapshot = { nodes: [...nodes].reverse(), edges: [...edges].reverse() }
    const one = computeArchDiff(base, target)
    const two = computeArchDiff({ nodes: [...base.nodes].reverse(), edges: base.edges }, shuffled)
    expect(two).toEqual(one)
    expect(one.diffHash).toBe(
      computeDiffHash({ version: 2, base: one.base, target: one.target, operations: one.operations })
    )
  })
})

describe('snapshotHash', () => {
  it('ignores CodeGraph ids, lines and timestamps, and sees structure', () => {
    const a = makeNode('n1', 'foo')
    const b = makeNode('n2', 'bar')
    const snap: GraphSnapshot = { nodes: [a, b], edges: [makeEdge('n1', 'n2')] }
    const reindexed: GraphSnapshot = {
      nodes: [
        { ...a, id: 'z1', startLine: 40, updatedAt: 99 },
        { ...b, id: 'z2' }
      ],
      edges: [makeEdge('z1', 'z2'), makeEdge('z1', 'z2')]
    }
    expect(snapshotHash(reindexed)).toBe(snapshotHash(snap))
    expect(snapshotHash({ nodes: [a, b], edges: [] })).not.toBe(snapshotHash(snap))
    expect(snapshotHash({ nodes: [a, { ...b, isExported: true }], edges: snap.edges })).not.toBe(snapshotHash(snap))
  })
})

describe('canonicalJson', () => {
  it('sorts keys, drops undefined fields and NFC-normalises text', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}')
    // "é" as e + combining acute and as one code point
    expect(canonicalJson({ name: 'café' })).toBe(canonicalJson({ name: 'café' }))
  })

  it('hashes ops identically however their keys were built', () => {
    const op1: ArchOp = { op: 'add_edge', edge: { source: 's', target: 't', kind: 'calls' } }
    const op2 = { edge: { kind: 'calls', target: 't', source: 's' }, op: 'add_edge' } as ArchOp
    expect(computeDiffHash({ version: 2, base: 'b', target: 't', operations: [op1] })).toBe(
      computeDiffHash({ version: 2, base: 'b', target: 't', operations: [op2] })
    )
  })
})
