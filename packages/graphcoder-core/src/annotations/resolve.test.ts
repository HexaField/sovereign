import { describe, expect, it } from 'vitest'
import type { GraphNode } from '../graph.js'
import { createMemberResolver, nodeSemanticId } from '../identity.js'
import { createAnnotation } from './store.js'
import { findStaleAnnotations, resolveAnnotation } from './resolve.js'

const fn = (name: string, filePath: string): GraphNode => ({
  id: `fn:${filePath}:${name}`,
  kind: 'function',
  name,
  qualifiedName: name,
  filePath,
  language: 'typescript',
  startLine: 1,
  endLine: 2,
  startColumn: 0,
  endColumn: 0
})

describe('resolveAnnotation', () => {
  const login = fn('login', 'src/auth.ts')
  const renderA = fn('render', 'src/a.tsx')
  const renderB = fn('render', 'src/b.tsx')
  const resolve = createMemberResolver([login, renderA, renderB])
  const ref = (n: GraphNode, file = n.filePath) => ({ id: nodeSemanticId(n), ref: n.name, file, note: '' })

  it('splits members into resolved and unresolved', () => {
    const gone = { id: '0'.repeat(64), ref: 'gone', file: 'src/gone.ts', note: '' }
    const annotation = { ...createAnnotation('Auth', [ref(login), gone]), id: 'auth' }
    expect(resolveAnnotation(annotation, resolve)).toEqual({ resolved: [ref(login)], unresolved: [gone] })
  })

  it('counts a colliding member as resolved only when its recorded file settles it', () => {
    const settled = { ...createAnnotation('Views', [ref(renderA)]), id: 'views' }
    const unsettled = { ...createAnnotation('Moved', [ref(renderA, 'src/old.tsx')]), id: 'moved' }
    const stale = findStaleAnnotations([settled, unsettled], resolve)
    expect([...stale.keys()]).toEqual(['moved'])
    expect(stale.get('moved')!.unresolved).toHaveLength(1)
  })
})
