import { describe, expect, it } from 'vitest'
import {
  AnchorError,
  declarationHead,
  findAnchor,
  leadingElement,
  normaliseSource,
  reindent,
  restoreSource
} from './text.js'
import { resolveSymbol } from './resolve.js'
import type { Declaration } from './types.js'

describe('normaliseSource / restoreSource', () => {
  it('round-trips a BOM and CRLF endings', () => {
    const raw = '\uFEFFa\r\nb\r\n'
    const src = normaliseSource(raw)
    expect(src).toEqual({ text: 'a\nb\n', bom: true, crlf: true })
    expect(restoreSource(src.text, src)).toBe(raw)
  })

  it('keeps LF files LF, including runs of blank lines', () => {
    const src = normaliseSource('a\n\n\nb\r\n')
    expect(src.crlf).toBe(false)
    expect(restoreSource('x\n\ny\n', src)).toBe('x\n\ny\n')
  })
})

describe('reindent', () => {
  it('re-bases continuation lines onto the target indent', () => {
    expect(reindent('function f() {\n  return 1\n}', '    ')).toBe('function f() {\n      return 1\n    }')
  })

  it('strips a common indent before re-basing', () => {
    expect(reindent('    if (a) {\n      b()\n    }\n', '\t')).toBe('if (a) {\n\t  b()\n\t}')
  })

  it('reads the base from the closing line when the first line lost its indent', () => {
    // Copied from inside a class, first line pasted flush left.
    expect(reindent('bump() {\n    this.n++\n  }', '  ')).toBe('bump() {\n    this.n++\n  }')
  })

  it('drops blank edges and keeps inner blank lines empty', () => {
    expect(reindent('\n\na()\n   \nb()\n\n', '  ')).toBe('a()\n\n  b()')
  })

  it('measures lines against an indented first line, so a dedent stays a dedent', () => {
    // Python: `b` sits outside the `if` that `a` is in; it must not move inside it.
    expect(reindent('      a = 10\n  b = 20', '        ')).toBe('a = 10\n    b = 20')
  })

  it('leaves code already at the target indent as it is, string text at column 0 included', () => {
    const code = '  sql() {\n    return `\nSELECT 1\n`\n  }'
    expect(reindent(code, '  ')).toBe(code.trimStart())
  })
})

describe('findAnchor', () => {
  const hay = 'function f() {\n  if (x) {\n    run()\n  }\n  return 1\n}'

  it('prefers an exact unique hit', () => {
    expect(findAnchor(hay, 'run()')).toEqual({
      start: hay.indexOf('run()'),
      end: hay.indexOf('run()') + 5,
      exact: true
    })
  })

  it('matches whole lines regardless of indentation', () => {
    const hit = findAnchor(hay, 'if (x) {\n  run()\n}')
    expect(hit.exact).toBe(false)
    expect(hay.slice(hit.start, hit.end)).toBe('if (x) {\n    run()\n  }')
  })

  it('falls back to per-line whitespace-insensitive matching', () => {
    const hit = findAnchor(hay, 'if (x) {\n        run()\n}')
    expect(hay.slice(hit.start, hit.end)).toBe('if (x) {\n    run()\n  }')
  })

  it('matches a single line with stray surrounding whitespace', () => {
    const hit = findAnchor(hay, '  return 1  ')
    expect(hay.slice(hit.start, hit.end)).toBe('return 1')
  })

  it('refuses ambiguity and absence', () => {
    expect(() => findAnchor('a a', 'a')).toThrow(AnchorError)
    try {
      findAnchor('x\nx', 'x')
    } catch (err) {
      expect((err as AnchorError).reason).toBe('many')
      expect((err as AnchorError).hits).toEqual([0, 2])
    }
    expect(() => findAnchor(hay, 'missing')).toThrow('no match')
    expect(() => findAnchor(hay, '   ')).toThrow('no match')
  })
})

describe('leading comments and decorators', () => {
  const ts = { comment: ['//', '/*'], decorator: ['@'] }
  it('classifies what a snippet opens with', () => {
    expect(leadingElement('/** doc */\nfunction f() {}', ts)).toBe('comment')
    expect(leadingElement('  @Get()\nm() {}', ts)).toBe('decorator')
    expect(leadingElement('export function f() {}', ts)).toBe('code')
    expect(leadingElement('#[inline]\nfn f() {}', { comment: ['//'], decorator: ['#['] })).toBe('decorator')
  })

  it('finds the declaration past multi-line decorators and comments', () => {
    const code = '/** doc */\n@Component({\n  selector: "x"\n})\n// note\nexport class X {}'
    expect(code.slice(declarationHead(code, ts))).toBe('export class X {}')
    const rs = '/// doc\n#[derive(Debug, Clone)]\npub struct A;'
    expect(rs.slice(declarationHead(rs, { comment: ['//'], decorator: ['#['] }))).toBe('pub struct A;')
  })
})

describe('resolveSymbol', () => {
  const decl = (qualifiedName: string, line: number, endLine = line): Declaration => ({
    name: qualifiedName.split('::').pop()!,
    qualifiedName,
    kind: 'method',
    triviaStart: 0,
    headStart: 0,
    end: 0,
    startLine: line,
    line,
    endLine
  })
  const decls = [
    decl('Store', 1, 20),
    decl('Store::total', 5, 7),
    decl('Store::total', 9, 11),
    decl('createModule::handleSend', 30, 33)
  ]

  it('matches a tail at a :: boundary, with . as an alias', () => {
    expect(resolveSymbol(decls, 'handleSend', 'f.ts').qualifiedName).toBe('createModule::handleSend')
    expect(resolveSymbol(decls, 'createModule.handleSend', 'f.ts').line).toBe(30)
    expect(() => resolveSymbol(decls, 'Send', 'f.ts')).toThrow("No symbol 'Send'")
  })

  it('refuses same-named declarations until @line picks one', () => {
    expect(() => resolveSymbol(decls, 'Store::total', 'f.ts')).toThrow(/matches 2 declarations.*Store::total@9/s)
    expect(resolveSymbol(decls, 'Store.total@10', 'f.ts').line).toBe(9)
    expect(() => resolveSymbol(decls, 'total@8', 'f.ts')).toThrow("No 'total' spans line 8")
  })

  it('suggests the closest name', () => {
    expect(() => resolveSymbol(decls, 'handleSnd', 'f.ts')).toThrow("Did you mean 'createModule::handleSend'?")
  })
})
