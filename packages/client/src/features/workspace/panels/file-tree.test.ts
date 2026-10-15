import { describe, it, expect } from 'vitest'
import { ancestorDirs, byDepth, findNode, rootFor, withChildren, type TreeNode } from './file-tree.js'

const dir = (path: string, children?: TreeNode[]): TreeNode => ({
  name: path.split('/').pop()!,
  path,
  type: 'directory',
  children
})
const file = (path: string): TreeNode => ({ name: path.split('/').pop()!, path, type: 'file' })

describe('rootFor', () => {
  const roots = [{ path: '/w' }, { path: '/w/org' }, { path: '/home/u/.sovereign' }]
  it('picks the longest root that holds the file', () => {
    expect(rootFor(roots, '/w/org/a/b.md')).toBe('/w/org')
    expect(rootFor(roots, '/w/other/b.md')).toBe('/w')
    expect(rootFor(roots, '/home/u/.sovereign/memory/x.md')).toBe('/home/u/.sovereign')
  })
  it('needs a whole path segment', () => {
    expect(rootFor(roots, '/w/organic/x.md')).toBe('/w')
    expect(rootFor(roots, '/elsewhere/x.md')).toBeUndefined()
    expect(rootFor(roots, '/w')).toBeUndefined()
  })
})

describe('ancestorDirs', () => {
  it('lists the directories above a file, outermost first', () => {
    expect(ancestorDirs('a/b/c.md')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('top.md')).toEqual([])
  })
})

describe('withChildren and findNode', () => {
  it('sets loaded children under a nested directory, prefixing their paths', () => {
    let tree = [dir('a'), file('x.md')]
    tree = withChildren(tree, 'a', [dir('b'), file('one.md')])
    tree = withChildren(tree, 'a/b', [file('c.md')])
    expect(findNode(tree, 'a/b/c.md')?.type).toBe('file')
    expect(findNode(tree, 'a/one.md')?.path).toBe('a/one.md')
    expect(findNode(tree, 'a/missing')).toBeUndefined()
  })
  it('leaves the tree unchanged when the directory is not loaded yet', () => {
    const tree = [dir('a')]
    expect(withChildren(tree, 'a/b', [file('c.md')])).toEqual(tree)
  })
})

describe('byDepth', () => {
  it('orders directories outermost first', () => {
    expect(byDepth(['a/b/c', 'z', 'a/b', 'a'])).toEqual(['z', 'a', 'a/b', 'a/b/c'])
  })
})
