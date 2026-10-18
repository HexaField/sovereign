import { describe, expect, it } from 'vitest'
import type { GraphNode } from './graph.js'
import { buildDiffIdMap, createMemberResolver, normalizeSignature, nodeSemanticId, semanticId } from './identity.js'

function makeNode(
  id: string,
  name: string,
  kind: GraphNode['kind'] = 'function',
  filePath = 'src/a.ts',
  signature?: string
): GraphNode {
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    signature
  }
}

describe('normalizeSignature', () => {
  it('collapses whitespace', () => {
    expect(normalizeSignature('a:  string')).toBe('a: string')
  })
  it('strips simple defaults', () => {
    expect(normalizeSignature('(a: string, b: number = 0)')).toBe('(a: string, b: number)')
  })
})

describe('semanticId', () => {
  it('produces a 64-char hex string', () => {
    const id = semanticId('function', 'foo', '(a: string): void')
    expect(id).toHaveLength(64)
    expect(id).toMatch(/^[0-9a-f]+$/)
  })

  it('is the sha256 of kind, name and normalised signature joined by NUL, as committed annotations record it', () => {
    // Annotation files in use hold ids computed this way; a change here would orphan every member
    expect(semanticId('function', 'add', '(a: number,  b: number = 1)')).toBe(
      semanticId('function', 'add', '(a: number, b: number)')
    )
    expect(semanticId('function', 'add', '(a: number, b: number): number')).toBe(
      '4ae16ad70c22ddc2b32ef528447306582fb5ab2804dd5cf2d933e4b2c6fae4e9'
    )
    expect(semanticId('function', 'foo')).toBe(semanticId('function', 'foo', ''))
  })

  it('is stable for identical inputs', () => {
    expect(semanticId('function', 'foo', '(a: string): void')).toBe(semanticId('function', 'foo', '(a: string): void'))
  })

  it('differs when name changes', () => {
    expect(semanticId('function', 'foo')).not.toBe(semanticId('function', 'bar'))
  })

  it('differs when kind changes', () => {
    expect(semanticId('function', 'foo')).not.toBe(semanticId('method', 'foo'))
  })
})

describe('nodeSemanticId', () => {
  it('matches semanticId(kind, name, signature) for symbol nodes, whatever the file', () => {
    const node = {
      kind: 'function' as const,
      name: 'add',
      filePath: 'src/math.ts',
      signature: '(a: number, b: number): number'
    }
    expect(nodeSemanticId(node)).toBe(semanticId(node.kind, node.name, node.signature))
    expect(nodeSemanticId({ ...node, filePath: 'src/arith.ts' })).toBe(nodeSemanticId(node))
  })

  it('uses filePath instead of name for file nodes', () => {
    const fileA = { kind: 'file' as const, name: 'index.ts', filePath: 'packages/client/src/index.ts' }
    const fileB = { kind: 'file' as const, name: 'index.ts', filePath: 'packages/server/src/index.ts' }
    expect(nodeSemanticId(fileA)).not.toBe(nodeSemanticId(fileB))
    expect(nodeSemanticId(fileA)).toBe(semanticId('file', fileA.filePath))
  })

  it('uses filePath instead of name for module nodes', () => {
    const modA = { kind: 'module' as const, name: 'utils', filePath: 'packages/core/src/utils.ts' }
    const modB = { kind: 'module' as const, name: 'utils', filePath: 'packages/server/src/utils.ts' }
    expect(nodeSemanticId(modA)).not.toBe(nodeSemanticId(modB))
  })
})

describe('buildDiffIdMap', () => {
  it('returns empty map for empty inputs', () => {
    expect(buildDiffIdMap([], []).size).toBe(0)
  })

  it('maps semantic IDs to CodeGraph IDs for target-only and base-only nodes', () => {
    const target = [makeNode('cg:func-1', 'add', 'function', 'src/math.ts', '(a, b)')]
    const base = [makeNode('cg:old-1', 'remove', 'function', 'src/math.ts')]
    const map = buildDiffIdMap(base, target)
    expect(map.get(nodeSemanticId(target[0]))).toBe('cg:func-1')
    expect(map.get(nodeSemanticId(base[0]))).toBe('cg:old-1')
  })

  it('lets the target CodeGraph ID win for the same semantic identity', () => {
    const base = [makeNode('cg:base-1', 'add', 'function', 'src/math.ts', '(a, b)')]
    const target = [makeNode('cg:target-1', 'add', 'function', 'src/math.ts', '(a, b)')]
    expect(buildDiffIdMap(base, target).get(nodeSemanticId(base[0]))).toBe('cg:target-1')
  })

  it('gives moved functions one entry', () => {
    const base = [makeNode('cg:old', 'add', 'function', 'src/old.ts', '(a, b)')]
    const target = [makeNode('cg:new', 'add', 'function', 'src/new.ts', '(a, b)')]
    const map = buildDiffIdMap(base, target)
    expect(map.size).toBe(1)
    expect(map.get(nodeSemanticId(base[0]))).toBe('cg:new')
  })

  it('keeps different signatures apart', () => {
    const base = [makeNode('cg:v1', 'add', 'function', 'src/a.ts', '(a: number)')]
    const target = [makeNode('cg:v2', 'add', 'function', 'src/a.ts', '(a: number, b: number)')]
    expect(buildDiffIdMap(base, target).size).toBe(2)
  })

  it('handles multiple nodes across both snapshots', () => {
    const base = [makeNode('cg:b1', 'foo'), makeNode('cg:b2', 'bar'), makeNode('cg:b3', 'baz', 'function', 'src/b.ts')]
    const target = [makeNode('cg:t1', 'foo'), makeNode('cg:t4', 'qux', 'function', 'src/c.ts')]
    const map = buildDiffIdMap(base, target)
    expect(map.get(nodeSemanticId(base[0]))).toBe('cg:t1')
    expect(map.get(nodeSemanticId(base[1]))).toBe('cg:b2')
    expect(map.get(nodeSemanticId(base[2]))).toBe('cg:b3')
    expect(map.get(nodeSemanticId(target[1]))).toBe('cg:t4')
    expect(map.size).toBe(4)
  })
})

describe('createMemberResolver', () => {
  const inApi = makeNode('fn:api:register', 'register', 'function', 'src/api/h.ts')
  const inUi = makeNode('fn:ui:register', 'register', 'function', 'src/ui/v.tsx')
  const member = (file: string) => ({ id: nodeSemanticId(inApi), file })

  it('matches a member to the symbol in its recorded file when names collide', () => {
    const resolve = createMemberResolver([inApi, inUi])
    expect(resolve(member('src/api/h.ts'))).toBe(inApi)
    expect(resolve(member('src/ui/v.tsx'))).toBe(inUi)
  })

  it('finds a moved member by its id alone when only one symbol has it', () => {
    expect(createMemberResolver([inApi])(member('src/old/place.ts'))).toBe(inApi)
  })

  it('resolves a moved member whose id now names several symbols to nothing', () => {
    expect(createMemberResolver([inApi, inUi])(member('src/old/place.ts'))).toBeUndefined()
  })

  it('never resolves to an import node or an unknown id', () => {
    const imported = { ...makeNode('import:register', 'register', 'import', 'src/ui/v.tsx') }
    const resolve = createMemberResolver([imported])
    expect(resolve({ id: nodeSemanticId(imported), file: 'src/ui/v.tsx' })).toBeUndefined()
    expect(createMemberResolver([inApi])({ id: 'f'.repeat(64), file: 'src/api/h.ts' })).toBeUndefined()
  })
})
