import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../graph.js'
import { nodeSemanticId } from '../identity.js'
import { compose } from './compose.js'
import { computeArchDiff } from './compute.js'
import { computeDiffHash } from './hash.js'
import { makeEdge, makeNode } from './fixtures.js'
import type { ArchDiff, ArchOp } from './types.js'

const snap = (nodes: GraphSnapshot['nodes'], edges: GraphSnapshot['edges'] = []): GraphSnapshot => ({ nodes, edges })

/** A hand-made diff with a valid hash */
function diff(base: string, target: string, operations: ArchOp[]): ArchDiff {
  const partial = { version: 2 as const, base, target, operations }
  return { ...partial, diffHash: computeDiffHash(partial) }
}

const foo = makeNode('n1', 'foo', 'function', 'src/a.ts', { visibility: 'private' })
const bar = makeNode('n2', 'bar', 'function', 'src/a.ts', { startLine: 40 })
const sem = (n: GraphSnapshot['nodes'][number]) => nodeSemanticId(n)

describe('compose', () => {
  it('refuses diffs that do not chain', () => {
    const ab = computeArchDiff(snap([]), snap([foo]))
    expect(() => compose(ab, ab)).toThrow(/Cannot compose/)
  })

  it('has the empty diff as identity on both sides', () => {
    const A = snap([foo])
    const B = snap([foo, bar], [makeEdge('n1', 'n2')])
    const ab = computeArchDiff(A, B)
    expect(compose(computeArchDiff(A, A), ab)).toEqual(ab)
    expect(compose(ab, computeArchDiff(B, B))).toEqual(ab)
  })

  it('matches the direct diff for a chain of edits', () => {
    const A = snap([foo, bar], [makeEdge('n1', 'n2')])
    const B = snap(
      [
        { ...foo, visibility: 'public' },
        { ...bar, filePath: 'src/b.ts' }
      ],
      []
    )
    const C = snap(
      [
        { ...foo, visibility: 'public', isExported: true },
        { ...bar, filePath: 'src/c.ts' },
        makeNode('n3', 'baz', 'function', 'src/z.ts')
      ],
      [makeEdge('n3', 'n1')]
    )
    expect(compose(computeArchDiff(A, B), computeArchDiff(B, C)).operations).toEqual(computeArchDiff(A, C).operations)
  })

  it('is associative', () => {
    const A = snap([foo])
    const B = snap([foo, bar], [makeEdge('n1', 'n2')])
    const C = snap([{ ...foo, isAsync: true }, bar], [makeEdge('n1', 'n2'), makeEdge('n2', 'n1')])
    const D = snap([{ ...foo, isAsync: true }], [])
    const [ab, bc, cd] = [computeArchDiff(A, B), computeArchDiff(B, C), computeArchDiff(C, D)]
    expect(compose(compose(ab, bc), cd)).toEqual(compose(ab, compose(bc, cd)))
    expect(compose(compose(ab, bc), cd).operations).toEqual(computeArchDiff(A, D).operations)
  })

  it('cancels a node added then removed, and an edge added then removed or removed then added', () => {
    const A = snap([foo])
    const B = snap([foo, bar], [makeEdge('n1', 'n2')])
    expect(compose(computeArchDiff(A, B), computeArchDiff(B, A)).operations).toEqual([])
    expect(compose(computeArchDiff(B, A), computeArchDiff(A, B)).operations).toEqual([])
  })

  it('folds a modify or move into an added node', () => {
    const A = snap([])
    const B = snap([foo])
    const C = snap([{ ...foo, visibility: 'public', filePath: 'src/moved.ts' }])
    expect(compose(computeArchDiff(A, B), computeArchDiff(B, C)).operations).toEqual([
      {
        op: 'add_node',
        node: expect.objectContaining({ id: sem(foo), visibility: 'public', filePath: 'src/moved.ts' })
      }
    ])
    const moveOnly = snap([{ ...foo, filePath: 'src/moved.ts' }])
    expect(compose(computeArchDiff(A, B), computeArchDiff(B, moveOnly)).operations).toEqual([
      { op: 'add_node', node: expect.objectContaining({ filePath: 'src/moved.ts', visibility: 'private' }) }
    ])
  })

  it('merges two modifies, keeping the first prev and the last next', () => {
    const A = snap([foo])
    const B = snap([{ ...foo, visibility: 'public' }])
    const C = snap([{ ...foo, visibility: 'protected', isAsync: true }])
    expect(compose(computeArchDiff(A, B), computeArchDiff(B, C)).operations).toEqual([
      {
        op: 'modify_node',
        id: sem(foo),
        prev: { visibility: 'private', isAsync: undefined },
        next: { visibility: 'protected', isAsync: true }
      }
    ])
  })

  it('chains moves a→b→c into a→c, and a move back cancels', () => {
    const at = (filePath: string) => snap([{ ...foo, filePath }])
    const ab = computeArchDiff(at('src/a.ts'), at('src/b.ts'))
    const bc = computeArchDiff(at('src/b.ts'), at('src/c.ts'))
    expect(compose(ab, bc).operations).toEqual([
      { op: 'move_node', id: sem(foo), from: { filePath: 'src/a.ts' }, to: { filePath: 'src/c.ts' } }
    ])
    expect(compose(ab, computeArchDiff(at('src/b.ts'), at('src/a.ts'))).operations).toEqual([])
  })

  it('folds a modify and a move on one node into one modify', () => {
    const A = snap([foo])
    const B = snap([{ ...foo, visibility: 'public' }])
    const C = snap([{ ...foo, visibility: 'public', filePath: 'src/b.ts' }])
    expect(compose(computeArchDiff(A, B), computeArchDiff(B, C)).operations).toEqual(computeArchDiff(A, C).operations)
    expect(compose(computeArchDiff(C, B), computeArchDiff(B, A)).operations).toEqual(computeArchDiff(C, A).operations)
  })

  it('removes a changed node with the content it had at the start', () => {
    const A = snap([foo])
    const B = snap([{ ...foo, visibility: 'public', filePath: 'src/b.ts' }])
    const composed = compose(computeArchDiff(A, B), computeArchDiff(B, snap([])))
    expect(composed.operations).toEqual(computeArchDiff(A, snap([])).operations)
  })

  it('turns a node removed and added back under the same identity into its field changes', () => {
    const A = snap([foo])
    const C = snap([{ ...foo, isExported: true }])
    const composed = compose(computeArchDiff(A, snap([])), computeArchDiff(snap([]), C))
    expect(composed.operations).toEqual(computeArchDiff(A, C).operations)
    expect(compose(computeArchDiff(A, snap([])), computeArchDiff(snap([]), A)).operations).toEqual([])
  })

  it('rejects chains no pair of real diffs can produce', () => {
    const fooSnap = {
      id: sem(foo),
      kind: foo.kind,
      name: foo.name,
      qualifiedName: foo.name,
      filePath: foo.filePath,
      language: 'typescript'
    }
    const edge = { source: 'a', target: 'b', kind: 'calls' as const }
    const pairs: Array<[ArchOp, ArchOp]> = [
      [
        { op: 'add_node', node: fooSnap },
        { op: 'add_node', node: fooSnap }
      ],
      [
        { op: 'remove_node', id: fooSnap.id, node: fooSnap },
        { op: 'remove_node', id: fooSnap.id, node: fooSnap }
      ],
      [
        { op: 'remove_node', id: fooSnap.id, node: fooSnap },
        { op: 'modify_node', id: fooSnap.id, prev: {}, next: {} }
      ],
      [
        { op: 'modify_node', id: fooSnap.id, prev: { isAsync: false }, next: { isAsync: true } },
        { op: 'add_node', node: fooSnap }
      ],
      [
        { op: 'add_edge', edge },
        { op: 'add_edge', edge }
      ],
      [
        { op: 'remove_edge', edge },
        { op: 'remove_edge', edge }
      ]
    ]
    for (const [first, second] of pairs) {
      expect(() => compose(diff('A', 'B', [first]), diff('B', 'C', [second])), `${first.op} then ${second.op}`).toThrow(
        /not a valid chain/
      )
    }
  })

  it('records base of the first, target of the second, canonical order and a fresh hash', () => {
    const composed = compose(
      diff('A', 'B', [{ op: 'add_edge', edge: { source: 'z', target: 'y', kind: 'calls' } }]),
      diff('B', 'C', [{ op: 'remove_edge', edge: { source: 'q', target: 'r', kind: 'calls' } }])
    )
    expect(composed.base).toBe('A')
    expect(composed.target).toBe('C')
    expect(composed.operations.map((o) => o.op)).toEqual(['remove_edge', 'add_edge'])
    expect(composed.diffHash).toBe(
      computeDiffHash({ version: 2, base: 'A', target: 'C', operations: composed.operations })
    )
  })
})
