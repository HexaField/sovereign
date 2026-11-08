import { describe, expect, it } from 'vitest'
import { changedSymbols, symbolsOnLines } from './changes.js'
import { changed, fileNode, sym } from './fixtures.js'

const names = (nodes: Array<{ name: string }>) => nodes.map((n) => n.name)

describe('symbolsOnLines', () => {
  const cls = sym('class', 'Session', 'a.ts', [1, 30])
  const open = sym('method', 'open', 'a.ts', [3, 12])
  const local = sym('variable', 'token', 'a.ts', [5, 5])
  const field = sym('property', 'id', 'a.ts', [14, 14])
  const all = [cls, open, local, field]

  it('gives a line to the innermost symbol holding it', () => {
    expect(names([...symbolsOnLines(all, [[14, 14]])])).toEqual(['id'])
    expect(names([...symbolsOnLines(all, [[20, 20]])])).toEqual(['Session'])
  })

  it('gives a local declared in a body to the function around it', () => {
    expect(names([...symbolsOnLines(all, [[5, 5]])])).toEqual(['open'])
  })

  it('finds nothing for lines outside every symbol', () => {
    expect(symbolsOnLines(all, [[40, 45]]).size).toBe(0)
  })
})

describe('changedSymbols', () => {
  it('reports an edited body as modified, and a symbol that only moved down the file as unchanged', () => {
    const base = [fileNode('a.ts'), sym('function', 'add', 'a.ts', [1, 3]), sym('function', 'sub', 'a.ts', [5, 7])]
    const head = [fileNode('a.ts'), sym('function', 'add', 'a.ts', [1, 4]), sym('function', 'sub', 'a.ts', [6, 8])]
    // one line added inside add(); sub() shifts by one
    const r = changedSymbols(base, head, [changed('a.ts', [[2, 0, 3, 1]])])
    expect(r.added).toEqual([])
    expect(r.removed).toEqual([])
    expect(r.modified.map((p) => p.head.name)).toEqual(['add'])
  })

  it('reports a deletion inside a body through the base side', () => {
    const base = [sym('function', 'add', 'a.ts', [1, 5])]
    const head = [sym('function', 'add', 'a.ts', [1, 4])]
    const r = changedSymbols(base, head, [changed('a.ts', [[3, 1, 2, 0]])])
    expect(r.modified.map((p) => p.head.name)).toEqual(['add'])
  })

  it('reports added and removed symbols, never files or imports', () => {
    const base = [fileNode('a.ts'), sym('import', './x', 'a.ts'), sym('function', 'old', 'a.ts', [3, 4])]
    const head = [fileNode('a.ts'), sym('function', 'fresh', 'a.ts', [3, 4])]
    const r = changedSymbols(base, head, [changed('a.ts', [[1, 4, 1, 4]])])
    expect(names(r.added)).toEqual(['fresh'])
    expect(names(r.removed)).toEqual(['old'])
  })

  it('pairs same-named symbols of one file in line order', () => {
    const base = [
      sym('method', 'new', 'a.rs', [2, 4], { qualifiedName: 'A::new' }),
      sym('method', 'new', 'a.rs', [8, 10], { qualifiedName: 'B::new' })
    ]
    const head = [
      sym('method', 'new', 'a.rs', [2, 4], { qualifiedName: 'A::new' }),
      sym('method', 'new', 'a.rs', [8, 11], { qualifiedName: 'B::new' }),
      sym('method', 'new', 'a.rs', [14, 16], { qualifiedName: 'C::new' })
    ]
    const r = changedSymbols(base, head, [
      changed('a.rs', [
        [9, 0, 10, 1],
        [11, 0, 13, 4]
      ])
    ])
    // the second `new` gained a line, a third `new` (C::new) is new
    expect(r.modified.map((p) => p.head.qualifiedName)).toEqual(['B::new'])
    expect(r.added.map((n) => n.qualifiedName)).toEqual(['C::new'])
  })

  it('keeps a function whose signature changed as modified, not removed and added', () => {
    const base = [sym('function', 'add', 'a.ts', [1, 3], { signature: '(a: number)' })]
    const head = [sym('function', 'add', 'a.ts', [1, 3], { signature: '(a: number, b: number)' })]
    const r = changedSymbols(base, head, [changed('a.ts', [[1, 1, 1, 1]])])
    expect(r.added).toEqual([])
    expect(r.removed).toEqual([])
    expect(r.modified).toHaveLength(1)
  })

  it('follows a renamed file, and counts its moved symbols as modified', () => {
    const base = [sym('function', 'f', 'src/a.ts', [1, 2]), sym('function', 'g', 'src/a.ts', [4, 5])]
    const head = [sym('function', 'f', 'lib/a.ts', [1, 2]), sym('function', 'g', 'lib/a.ts', [4, 6])]
    const r = changedSymbols(base, head, [
      changed('lib/a.ts', [[5, 0, 6, 1]], { status: 'renamed', oldPath: 'src/a.ts' })
    ])
    expect(r.added).toEqual([])
    expect(r.removed).toEqual([])
    expect(r.modified.map((p) => [p.base.filePath, p.head.filePath, p.head.name])).toEqual([
      ['src/a.ts', 'lib/a.ts', 'f'],
      ['src/a.ts', 'lib/a.ts', 'g']
    ])
  })

  it('follows a symbol moved between two changed files when its id is unique among the leftovers', () => {
    const base = [sym('function', 'helper', 'a.ts', [10, 12]), sym('function', 'dup', 'a.ts', [14, 15])]
    const head = [sym('function', 'helper', 'b.ts', [1, 3]), sym('function', 'dup', 'b.ts', [5, 6])]
    const r = changedSymbols(base, head, [changed('a.ts', [[10, 6, 9, 0]]), changed('b.ts', [[0, 0, 1, 6]])])
    expect(r.modified.map((p) => p.head.name).sort()).toEqual(['dup', 'helper'])
  })

  it('ignores symbols in files the change does not touch', () => {
    const base = [sym('function', 'f', 'a.ts', [1, 2]), sym('function', 'g', 'other.ts', [1, 2])]
    const head = [sym('function', 'f', 'a.ts', [1, 3])]
    const r = changedSymbols(base, head, [changed('a.ts', [[2, 0, 3, 1]])])
    expect(r.removed).toEqual([])
    expect(r.modified.map((p) => p.head.name)).toEqual(['f'])
  })

  it('reads every symbol of an added file as added and of a deleted file as removed', () => {
    const head = [fileNode('new.ts'), sym('function', 'a', 'new.ts'), sym('class', 'B', 'new.ts', [3, 9])]
    const base = [sym('function', 'gone', 'old.ts')]
    const r = changedSymbols(base, head, [
      changed('new.ts', [[0, 0, 1, 9]], { status: 'added' }),
      changed('old.ts', [[1, 1, 0, 0]], { status: 'deleted' })
    ])
    expect(names(r.added)).toEqual(['a', 'B'])
    expect(names(r.removed)).toEqual(['gone'])
  })
})
