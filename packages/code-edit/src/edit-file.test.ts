import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Analyzer, EditArgs, EditOp } from './types.js'
import { createAnalyzer } from './analyzer.js'
import { editFile, type EditFileOptions } from './edit-file.js'

const hasCodegraph = spawnSync('codegraph', ['--version']).status === 0
const hasPython = spawnSync('python3', ['--version']).status === 0

let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-edit-')))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function put(name: string, content: string): string {
  const file = path.join(tmp, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

const read = (file: string) => fs.readFileSync(file, 'utf8')

function edit(file: string, ops: EditOp[], extra: Partial<EditArgs> = {}, opts: EditFileOptions = {}) {
  return editFile({ file, ops, ...extra }, { roots: [tmp], graph: false, ...opts })
}

const TS = `import { a } from './a'

/** Adds one. */
export function addOne(x: number): number {
  return x + 1
}

export const double = (x: number) => {
  return x * 2
}

export enum Mode { Fast, Slow, Idle }

export class Store {
  /** Current count. */
  count = 0

  @Log()
  bump(by: number): void {
    this.count += by
  }

  get total(): number {
    return this.count
  }

  set total(v: number) {
    this.count = v
  }
}

export function createModule() {
  function helper() {
    return 1
  }

  async function handleSend(text: string) {
    return text.trim()
  }

  return { helper, handleSend }
}
`

describe('replace (TypeScript)', () => {
  it('keeps the doc comment and export when the code omits them', async () => {
    const file = put('s.ts', TS)
    const r = await edit(file, [
      { op: 'replace', symbol: 'addOne', code: 'function addOne(x: number): number {\n  return x + 2\n}' }
    ])
    expect(read(file)).toBe(TS.replace('return x + 1', 'return x + 2'))
    expect(r.report).toContain("kept 'export'")
    expect(r.report).toContain('syntax ok')
    expect(r.report).toMatch(/^-  return x \+ 1$/m)
    expect(r.report).toMatch(/^\+  return x \+ 2$/m)
  })

  it('replaces the doc comment when the code starts with one', async () => {
    const file = put('s.ts', TS)
    await edit(file, [
      {
        op: 'replace',
        symbol: 'addOne',
        code: '/** Adds two. */\nexport function addOne(x: number): number {\n  return x + 2\n}'
      }
    ])
    expect(read(file)).toBe(TS.replace('/** Adds one. */', '/** Adds two. */').replace('return x + 1', 'return x + 2'))
  })

  it('replaces only the value of a function held in a const, or the whole statement', async () => {
    const file = put('s.ts', TS)
    const r = await edit(file, [{ op: 'replace', symbol: 'double', code: '(x: number) => x * 2' }])
    expect(read(file)).toContain('export const double = (x: number) => x * 2\n\nexport enum')
    expect(r.report).toContain('replace double (value)')

    await edit(file, [{ op: 'replace', symbol: 'double', code: 'const double = (x: number, k = 2) => x * k' }])
    expect(read(file)).toContain('export const double = (x: number, k = 2) => x * k\n')
  })

  it('keeps a member decorator unless the code brings its own', async () => {
    const file = put('s.ts', TS)
    await edit(file, [
      { op: 'replace', symbol: 'Store::bump', code: 'bump(by: number): void {\n  this.count += by * 2\n}' }
    ])
    expect(read(file)).toContain('  @Log()\n  bump(by: number): void {\n    this.count += by * 2\n  }\n')

    await edit(file, [{ op: 'replace', symbol: 'bump', code: "@Log('bump')\nbump(): void {\n  this.count++\n}" }])
    expect(read(file)).toContain("  @Log('bump')\n  bump(): void {\n    this.count++\n  }\n")
    expect(read(file)).not.toContain('@Log()')
  })

  it('keeps a comment after the declaration on its last line, unless the code ends with its own', async () => {
    const SRC = 'export const TIMEOUT = 5000 // ms\n\nexport function f() {\n  return 1\n} // end f\n'
    const file = put('t.ts', SRC)
    await edit(file, [
      { op: 'replace', symbol: 'TIMEOUT', code: 'const TIMEOUT = 10_000' },
      { op: 'replace', symbol: 'f', code: 'function f() {\n  return 2\n}' }
    ])
    expect(read(file)).toBe(SRC.replace('5000', '10_000').replace('return 1', 'return 2'))

    await edit(file, [{ op: 'replace', symbol: 'TIMEOUT', code: 'const TIMEOUT = 20_000 // milliseconds' }])
    expect(read(file).split('\n')[0]).toBe('export const TIMEOUT = 20_000 // milliseconds')
    await edit(file, [{ op: 'replace_in', symbol: 'TIMEOUT', find: '// milliseconds', code: '// ms, raised for CI' }])
    expect(read(file).split('\n')[0]).toBe('export const TIMEOUT = 20_000 // ms, raised for CI')
  })

  it('replaces a comment on the last statement of a body along with the body', async () => {
    const py = put('b.py', 'def f():\n    return 1  # one\n')
    await edit(py, [{ op: 'replace', symbol: 'f', code: 'def f():\n    return 2' }])
    expect(read(py)).toBe('def f():\n    return 2\n')
    const ts = put('u.ts', 'type T =\n  | A\n  | B // last\n')
    await edit(ts, [{ op: 'replace', symbol: 'T', code: 'type T = A' }])
    expect(read(ts)).toBe('type T = A\n')
  })

  it('keeps the decorators when the code brings a new doc comment but no decorators', async () => {
    const file = put(
      'd.ts',
      "class C {\n  /** Old doc. */\n  @Input()\n  @Log()\n  name(): string {\n    return 'a'\n  }\n}\n"
    )
    const r = await edit(file, [
      { op: 'replace', symbol: 'name', code: "/** New doc. */\nname(): string {\n  return 'b'\n}" }
    ])
    expect(read(file)).toBe(
      "class C {\n  /** New doc. */\n  @Input()\n  @Log()\n  name(): string {\n    return 'b'\n  }\n}\n"
    )
    expect(r.report).toContain('kept the decorators')
  })

  it('takes decorators that share a line or sit after a blank line along with the member', async () => {
    // Left behind, the decorators would silently decorate `other`: still valid syntax.
    const file = put('m.ts', 'class C {\n  @A() @B()\n  foo() {}\n\n  other = 1\n}\n')
    await edit(file, [{ op: 'remove', symbol: 'foo' }])
    expect(read(file)).toBe('class C {\n  other = 1\n}\n')
    const spaced = put('n.ts', 'class C {\n  @A()\n\n  foo() {}\n\n  other = 1\n}\n')
    await edit(spaced, [{ op: 'remove', symbol: 'foo' }])
    expect(read(spaced)).toBe('class C {\n  other = 1\n}\n')
    const rs = put('t.rs', '#[cfg(test)]\n\nfn only_in_tests() {}\n\nfn keep() {}\n')
    await edit(rs, [{ op: 'remove', symbol: 'only_in_tests' }])
    expect(read(rs)).toBe('fn keep() {}\n')
  })

  it('removes the overload signatures with the implementation, and inserts above them', async () => {
    const OV =
      'export const a = 1\n\nexport function f(x: string): string\nexport function f(x: number): number\nexport function f(x: any): any {\n  return x\n}\n'
    const file = put('o.ts', OV)
    await edit(file, [{ op: 'insert', before: 'f', code: 'export const b = 2' }])
    expect(read(file)).toBe(
      OV.replace('export function f(x: string)', 'export const b = 2\n\nexport function f(x: string)')
    )
    await edit(file, [{ op: 'remove', symbol: 'f' }])
    expect(read(file)).toBe('export const a = 1\n\nexport const b = 2\n')
  })

  it('edits a function nested in a factory, by its short name, at its own indent', async () => {
    const file = put('s.ts', TS)
    const r = await edit(file, [
      {
        op: 'replace',
        symbol: 'handleSend',
        code: 'async function handleSend(text: string, loud = false) {\n  return loud ? text.toUpperCase() : text.trim()\n}'
      }
    ])
    expect(read(file)).toContain(
      '  async function handleSend(text: string, loud = false) {\n    return loud ? text.toUpperCase() : text.trim()\n  }\n'
    )
    expect(r.report).toContain('replace createModule::handleSend')
  })

  it('refuses a getter/setter pair until @line picks one', async () => {
    const file = put('s.ts', TS)
    await expect(edit(file, [{ op: 'remove', symbol: 'Store::total' }])).rejects.toThrow(/matches 2 declarations/)
    const setterLine = TS.slice(0, TS.indexOf('set total')).split('\n').length
    await edit(file, [{ op: 'remove', symbol: `Store.total@${setterLine}` }])
    expect(read(file)).toContain('get total(): number')
    expect(read(file)).not.toContain('set total')
  })

  it('reports a rename, and rejects code that holds no declaration', async () => {
    const file = put('s.ts', TS)
    const r = await edit(file, [
      { op: 'replace', symbol: 'addOne', code: 'export function addUp(x: number): number {\n  return x + 1\n}' }
    ])
    expect(r.report).toContain('renamed addOne → addUp; references are not updated')
    await expect(edit(file, [{ op: 'replace', symbol: 'addUp', code: 'console.log(1)' }])).rejects.toThrow(
      /holds no declaration/
    )
  })

  it('rejects an edit that breaks the syntax and leaves the file alone', async () => {
    const file = put('s.ts', TS)
    await expect(
      edit(file, [
        { op: 'replace', symbol: 'addOne', code: 'export function addOne(x: number): number {\n  return (x + 1\n}' }
      ])
    ).rejects.toThrow(/breaks the syntax: .* at line \d+:\d+/)
    expect(read(file)).toBe(TS)
  })

  it('applies ops in order and writes nothing when a later one fails', async () => {
    const file = put('s.ts', TS)
    await expect(
      edit(file, [
        { op: 'replace_in', symbol: 'addOne', find: 'x + 1', code: 'x + 5' },
        { op: 'remove', symbol: 'noSuchThing' }
      ])
    ).rejects.toThrow(/op 2 \(remove\): No symbol 'noSuchThing'/)
    expect(read(file)).toBe(TS)
  })
})

describe('replace_in', () => {
  it('replaces a unique exact match inside the symbol', async () => {
    const file = put('s.ts', TS)
    await edit(file, [{ op: 'replace_in', symbol: 'addOne', find: 'x + 1', code: 'x + 3' }])
    expect(read(file)).toBe(TS.replace('x + 1', 'x + 3'))
  })

  it('matches ignoring indentation and re-indents the code', async () => {
    const file = put('s.ts', TS)
    const r = await edit(file, [
      {
        op: 'replace_in',
        symbol: 'createModule',
        find: 'function helper() {\n  return 1\n}',
        code: 'function helper() {\n  return 42\n}'
      }
    ])
    expect(read(file)).toContain('  function helper() {\n    return 42\n  }\n')
    expect(r.report).toContain('matched ignoring indentation')
  })

  it('replaces a range from find to to', async () => {
    const file = put('s.ts', TS)
    await edit(file, [
      { op: 'replace_in', symbol: 'Store::bump', find: 'this.count', to: 'by', code: 'this.count -= by' }
    ])
    expect(read(file)).toContain('    this.count -= by\n')
  })

  it('names every hit when find is ambiguous, and shows the text when it misses', async () => {
    const file = put('s.ts', TS)
    await expect(edit(file, [{ op: 'replace_in', symbol: 'createModule', find: 'return', code: 'x' }])).rejects.toThrow(
      /find matches 3 places in 'createModule' \(lines 34, 38, 41\)/
    )
    await expect(edit(file, [{ op: 'replace_in', symbol: 'addOne', find: 'x - 1', code: 'x' }])).rejects.toThrow(
      /matches nothing in 'addOne'\. Its current text:\n3 \| \/\*\* Adds one\. \*\/\n4 \| export function addOne/
    )
  })

  it('names the real lines when to is ambiguous', async () => {
    const file = put('f.ts', 'const a = 1\n\nfunction f() {\n  // call run() here\n  run()\n}\n')
    await expect(
      edit(file, [{ op: 'replace_in', symbol: 'f', find: '// call', to: 'run()', code: '// go' }])
    ).rejects.toThrow(/to matches 2 places in 'f' after find \(lines 4, 5\)/)
  })

  it('keeps a Python statement outside the block it followed when the code is re-indented', async () => {
    const PY = 'def f(x):\n    if x:\n        a = 1\n    b = 2\n    return a + b\n'
    const file = put('p.py', PY)
    // find and code both carry a consistent but wrong absolute indent, so the match ignores indentation.
    await edit(file, [{ op: 'replace_in', symbol: 'f', find: '      a = 1\n  b = 2', code: '      a = 10\n  b = 20' }])
    expect(read(file)).toBe(PY.replace('a = 1', 'a = 10').replace('b = 2', 'b = 20'))
  })

  it('searches the whole file when no symbol is given', async () => {
    const file = put('s.ts', TS)
    await edit(file, [
      { op: 'replace_in', find: "import { a } from './a'", code: "import { a } from './a'\nimport { b } from './b'" }
    ])
    expect(read(file).startsWith("import { a } from './a'\nimport { b } from './b'\n\n/** Adds one. */")).toBe(true)
  })
})

describe('insert and remove', () => {
  it('inserts after a symbol with one blank line on each side', async () => {
    const file = put('s.ts', TS)
    await edit(file, [
      { op: 'insert', after: 'addOne', code: 'export function addTwo(x: number): number {\n  return x + 2\n}' }
    ])
    expect(read(file)).toContain(
      '  return x + 1\n}\n\nexport function addTwo(x: number): number {\n  return x + 2\n}\n\nexport const double'
    )
  })

  it('inserts before a symbol, above its decorators, at its indent', async () => {
    const file = put('s.ts', TS)
    await edit(file, [{ op: 'insert', before: 'Store::bump', code: 'reset(): void {\n  this.count = 0\n}' }])
    expect(read(file)).toContain('  count = 0\n\n  reset(): void {\n    this.count = 0\n  }\n\n  @Log()\n  bump(')
  })

  it('appends at the end of the file', async () => {
    const file = put('s.ts', TS)
    await edit(file, [{ op: 'insert', code: 'export const LIMIT = 3' }])
    expect(read(file)).toBe(TS + '\nexport const LIMIT = 3\n')
  })

  it('removes a declaration with its doc comment and tidies the blank lines', async () => {
    const file = put('s.ts', TS)
    await edit(file, [{ op: 'remove', symbol: 'addOne' }])
    expect(read(file).startsWith("import { a } from './a'\n\nexport const double")).toBe(true)
  })

  it('removes a mid-line member with its separator', async () => {
    const file = put('s.ts', TS)
    await edit(file, [{ op: 'remove', symbol: 'Mode::Slow' }])
    expect(read(file)).toContain('export enum Mode { Fast, Idle }')
    await edit(file, [{ op: 'remove', symbol: 'Mode::Idle' }])
    expect(read(file)).toContain('export enum Mode { Fast }')
  })

  it('removes a member that ends its line with a separator, line and all', async () => {
    const file = put('e.ts', 'enum Mode {\n  Fast,\n  Slow, // rarely used\n  Idle,\n}\n')
    await edit(file, [{ op: 'remove', symbol: 'Slow' }])
    expect(read(file)).toBe('enum Mode {\n  Fast,\n  Idle,\n}\n')
  })

  it('leaves the wider of the two gaps between the neighbours of a removed declaration', async () => {
    const file = put('g.py', 'def a():\n    pass\n\n\ndef f():\n    pass\n\n\ndef b():\n    pass\n')
    await edit(file, [{ op: 'remove', symbol: 'f' }])
    expect(read(file)).toBe('def a():\n    pass\n\n\ndef b():\n    pass\n')
  })

  it('never takes a file or module comment along with a declaration', async () => {
    const rs = put('lib.rs', '//! Module docs.\npub fn first() {}\n\npub fn second() {}\n')
    await edit(rs, [{ op: 'remove', symbol: 'first' }])
    expect(read(rs)).toBe('//! Module docs.\n\npub fn second() {}\n')
    const py = put('main.py', '#!/usr/bin/env python3\ndef main():\n    print(1)\n\n\ndef other():\n    pass\n')
    await edit(py, [{ op: 'remove', symbol: 'main' }])
    expect(read(py)).toBe('#!/usr/bin/env python3\n\n\ndef other():\n    pass\n')
  })
})

describe('create and missing files', () => {
  it('creates a file and its directories', async () => {
    const file = path.join(tmp, 'sub', 'dir', 'new.ts')
    const r = await edit(file, [{ op: 'create', code: 'export const x = 1' }])
    expect(read(file)).toBe('export const x = 1\n')
    expect(r.report.startsWith('Created sub/dir/new.ts')).toBe(false) // no git root: base name
    expect(r.report.startsWith('Created new.ts')).toBe(true)
  })

  it('refuses to create over a file, to edit a missing one, or to create broken code', async () => {
    const file = put('s.ts', TS)
    await expect(edit(file, [{ op: 'create', code: 'x' }])).rejects.toThrow('already exists')
    await expect(edit(path.join(tmp, 'nope.ts'), [{ op: 'remove', symbol: 'a' }])).rejects.toThrow('does not exist')
    await expect(edit(path.join(tmp, 'bad.ts'), [{ op: 'create', code: 'function (' }])).rejects.toThrow(
      /create: .* at line 1/
    )
  })
})

describe('files that do not parse', () => {
  const BROKEN = 'export function ok() {\n  return 1\n}\nexport function bad( {\n'

  it('still resolves symbols in a broken file, and lets edits through that add no error', async () => {
    const file = put('b.ts', BROKEN)
    const r = await edit(file, [{ op: 'remove', symbol: 'ok' }])
    expect(read(file)).toBe('export function bad( {\n')
    expect(r.report).toContain('syntax ok')
    await edit(file, [{ op: 'replace_in', find: 'bad( {', code: 'bad() {}' }])
    expect(read(file)).toBe('export function bad() {}\n')
  })

  // tree-sitter-typescript 0.23 misparses an array of an inline import type:
  // valid TypeScript that the grammar reports as an error.
  const GAP = `export interface Api {
  send(text: string, files?: import('./types').File[]): void
}

export function total(xs: number[]): number {
  return xs.length
}
`

  it('edits valid code the grammar misreads, judging only the problems an edit adds', async () => {
    const file = put('gap.ts', GAP)
    const r = await edit(file, [
      {
        op: 'replace',
        symbol: 'total',
        code: 'export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0)\n}'
      }
    ])
    expect(read(file)).toContain('return xs.reduce((a, b) => a + b, 0)')
    expect(r.report).toContain('syntax ok')
    expect(r.report).not.toMatch(/syntax error|already/)
  })

  it('still rejects a real error in a file with a grammar gap', async () => {
    const file = put('gap.ts', GAP)
    await expect(
      edit(file, [{ op: 'replace_in', symbol: 'total', find: 'return xs.length', code: 'return (xs.length' }])
    ).rejects.toThrow(/breaks the syntax/)
    expect(read(file)).toBe(GAP)
  })

  it('checks the syntax of a language with no widening profile (Java)', async () => {
    const JAVA =
      'public class Greeter {\n    public String greet(String name) {\n        return "hi " + name;\n    }\n}\n'
    const file = put('Greeter.java', JAVA)
    await edit(file, [{ op: 'replace_in', symbol: 'Greeter::greet', find: '"hi "', code: '"hello "' }])
    expect(read(file)).toContain('return "hello " + name;')
    await expect(edit(file, [{ op: 'replace_in', symbol: 'greet', find: 'name;', code: 'name' }])).rejects.toThrow(
      /breaks the syntax/
    )
  })
})

describe('line endings, indentation, and the write path', () => {
  it('preserves a BOM and CRLF endings', async () => {
    const file = put('w.ts', '\uFEFFexport function a() {\r\n  return 1\r\n}\r\n')
    await edit(file, [{ op: 'replace', symbol: 'a', code: 'export function a() {\n  return 2\n}' }])
    const out = read(file)
    expect(out).toBe('\uFEFFexport function a() {\r\n  return 2\r\n}\r\n')
  })

  it('keeps the line endings of untouched lines in a file that mixes LF and CRLF', async () => {
    const MIXED = 'export function a() {\r\n  return 1\r\n}\n\nexport function b() {\n  return 2\n}\n'
    const file = put('m.ts', MIXED)
    await edit(file, [
      { op: 'replace_in', symbol: 'b', find: 'return 2', code: 'const two = 2\n  return two' },
      { op: 'insert', code: 'export const c = 3' }
    ])
    expect(read(file)).toBe(MIXED.replace('  return 2\n', '  const two = 2\n  return two\n') + '\nexport const c = 3\n')
  })

  it('refuses a file that is not UTF-8 instead of rewriting its other bytes', async () => {
    const file = path.join(tmp, 'latin1.py')
    const bytes = Buffer.concat([
      Buffer.from('def a():\n    return "caf'),
      Buffer.from([0xe9]),
      Buffer.from('"\n\n\ndef b():\n    return 1\n')
    ])
    fs.writeFileSync(file, bytes)
    await expect(edit(file, [{ op: 'replace_in', symbol: 'b', find: 'return 1', code: 'return 2' }])).rejects.toThrow(
      'not UTF-8'
    )
    expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  })

  it('keeps tab indentation in Go and edits one spec of a grouped type', async () => {
    const GO =
      'package main\n\n// Server serves.\ntype Server struct {\n\tport int\n}\n\n// Start starts it.\nfunc (s *Server) Start() error {\n\treturn nil\n}\n\ntype (\n\tID   string\n\tName string\n)\n'
    const file = put('main.go', GO)
    await edit(file, [
      { op: 'replace', symbol: 'Server.Start', code: 'func (s *Server) Start() error {\n\treturn s.run()\n}' },
      { op: 'replace', symbol: 'ID', code: 'ID int64' }
    ])
    expect(read(file)).toBe(GO.replace('\treturn nil', '\treturn s.run()').replace('\tID   string', '\tID int64'))
  })

  it('does not write on a dry run', async () => {
    const file = put('s.ts', TS)
    const r = await edit(file, [{ op: 'remove', symbol: 'addOne' }], { dryRun: true })
    expect(r.written).toBe(false)
    expect(r.report.startsWith('Dry run, nothing written: s.ts')).toBe(true)
    expect(read(file)).toBe(TS)
  })

  it('refuses to write when the file changed during the edit', async () => {
    const file = put('s.ts', TS)
    const real = createAnalyzer()
    let calls = 0
    const racing: Analyzer = {
      analyze(p, text) {
        if (++calls === 2) fs.appendFileSync(file, '// someone else\n')
        return real.analyze(p, text)
      }
    }
    await expect(edit(file, [{ op: 'remove', symbol: 'addOne' }], {}, { analyzer: racing })).rejects.toThrow(
      /changed on disk during the edit/
    )
    expect(read(file)).toBe(TS + '// someone else\n')
  })

  it('writes through a symlink and keeps the file mode', async () => {
    const real = put('real.ts', TS)
    fs.chmodSync(real, 0o755)
    const link = path.join(tmp, 'link.ts')
    fs.symlinkSync(real, link)
    const r = await edit(link, [{ op: 'replace_in', symbol: 'addOne', find: 'x + 1', code: 'x + 9' }])
    expect(r.path).toBe(real)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(read(real)).toContain('x + 9')
    expect(fs.statSync(real).mode & 0o777).toBe(0o755)
    expect(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('never exposes the new content with wider permissions than the file had', async () => {
    const file = put('secret.ts', TS)
    fs.chmodSync(file, 0o600)
    // The mode of each temp file at the moment its content is on disk.
    const modes: number[] = []
    const write = fs.writeFileSync
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p, data, opts) => {
      write(p, data, opts)
      if (String(p).endsWith('.tmp')) modes.push(fs.statSync(String(p)).mode & 0o777)
    }) as typeof fs.writeFileSync)
    try {
      await edit(file, [{ op: 'replace_in', symbol: 'addOne', find: 'x + 1', code: 'x + 9' }])
    } finally {
      spy.mockRestore()
    }
    expect(modes).toEqual([0o600])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('accepts / as a root', async () => {
    const file = put('s.ts', TS)
    await editFile({ file, ops: [{ op: 'remove', symbol: 'addOne' }] }, { roots: ['/'], graph: false })
    expect(read(file)).not.toContain('addOne')
  })

  it('guards roots, secrets, dependency trees, and relative paths', async () => {
    const file = put('s.ts', TS)
    await expect(editFile({ file, ops: [] }, { roots: [path.join(tmp, 'other')] })).rejects.toThrow(
      'outside the allowed roots'
    )
    await expect(edit(put('node_modules/x/i.ts', TS), [{ op: 'remove', symbol: 'addOne' }])).rejects.toThrow(
      'node_modules'
    )
    await expect(edit(put('.env', 'A=1\n'), [{ op: 'replace_in', find: 'A=1', code: 'A=2' }])).rejects.toThrow(
      'secrets'
    )
    await expect(editFile({ file: 's.ts', ops: [] })).rejects.toThrow('absolute path')
  })
})

describe('other languages', () => {
  it('TSX: replaces a component', async () => {
    const file = put(
      'c.tsx',
      'export function Card(props: { title: string }) {\n  return <div class="card">{props.title}</div>\n}\n'
    )
    await edit(file, [
      {
        op: 'replace',
        symbol: 'Card',
        code: 'export function Card(props: { title: string }) {\n  return (\n    <div class="card">\n      <h2>{props.title}</h2>\n    </div>\n  )\n}'
      }
    ])
    expect(read(file)).toContain('      <h2>{props.title}</h2>\n')
  })

  it('Python: keeps the decorator, re-indents, and inserts at the method indent', async () => {
    const PY =
      'import os\n\n\nclass Voice:\n    """Speaks."""\n\n    def __init__(self, rate: int) -> None:\n        self.rate = rate\n\n    @staticmethod\n    def speak(text):\n        return text\n'
    const file = put('v.py', PY)
    await edit(file, [
      {
        op: 'replace',
        symbol: 'Voice.speak',
        code: 'def speak(text, loud=False):\n    return text.upper() if loud else text'
      },
      { op: 'insert', after: 'Voice::__init__', code: 'def stop(self):\n    pass' },
      { op: 'replace_in', symbol: '__init__', find: 'self.rate = rate', code: 'self.rate = max(rate, 8000)' }
    ])
    expect(read(file)).toBe(
      'import os\n\n\nclass Voice:\n    """Speaks."""\n\n    def __init__(self, rate: int) -> None:\n        self.rate = max(rate, 8000)\n\n    def stop(self):\n        pass\n\n    @staticmethod\n    def speak(text, loud=False):\n        return text.upper() if loud else text\n'
    )
  })

  it('Python: a comment above the first statement of a block goes with it; comments between decorators stay', async () => {
    const PY =
      'class A:\n    # Cached.\n    @property\n    def x(self):\n        return 1\n\n    def y(self):\n        return 2\n'
    const file = put('c.py', PY)
    await edit(file, [{ op: 'replace', symbol: 'x', code: '# Cached twice.\ndef x(self):\n    return 2' }])
    expect(read(file)).toBe(PY.replace('# Cached.', '# Cached twice.').replace('return 1', 'return 2'))
    await edit(file, [{ op: 'remove', symbol: 'x' }])
    expect(read(file)).toBe('class A:\n    def y(self):\n        return 2\n')

    const decorated = put('d.py', '@a\n# note\n@b\ndef f():\n    pass\n')
    await edit(decorated, [{ op: 'replace', symbol: 'f', code: 'def f():\n    return 1' }])
    expect(read(decorated)).toBe('@a\n# note\n@b\ndef f():\n    return 1\n')
  })

  it('Rust: keeps the attributes when the code brings a new doc comment but no attributes', async () => {
    const file = put('a.rs', '/// An agent.\n#[derive(Debug, Clone)]\npub struct Agent {\n    pub id: u32,\n}\n')
    await edit(file, [
      { op: 'replace', symbol: 'Agent', code: '/// A better agent.\nstruct Agent {\n    pub id: u64,\n}' }
    ])
    expect(read(file)).toBe('/// A better agent.\n#[derive(Debug, Clone)]\npub struct Agent {\n    pub id: u64,\n}\n')
  })

  it.skipIf(!hasPython)('Python: rejects indentation the grammar accepts but CPython does not', async () => {
    const file = put('v.py', 'class Voice:\n    def stop(self):\n        pass\n')
    await expect(edit(file, [{ op: 'replace', symbol: 'stop', code: 'def stop(self):\npass' }])).rejects.toThrow(
      /breaks the syntax: IndentationError: expected an indented block/
    )
    await expect(
      edit(file, [{ op: 'replace_in', symbol: 'stop', find: '        pass', code: 'pass\n  return 1' }])
    ).rejects.toThrow(/breaks the syntax: IndentationError/)
  })

  it('Rust: keeps pub and the doc comment, and removes a struct with its attributes', async () => {
    const RS =
      '/// An agent.\n#[derive(Debug)]\npub struct Agent {\n    pub id: u32,\n}\n\nimpl Agent {\n    /// Make one.\n    pub fn new(id: u32) -> Self {\n        Agent { id }\n    }\n}\n'
    const file = put('lib.rs', RS)
    const r = await edit(file, [
      { op: 'replace', symbol: 'Agent::new', code: 'fn new(id: u32) -> Self {\n    Agent { id: id + 1 }\n}' }
    ])
    expect(read(file)).toContain(
      '    /// Make one.\n    pub fn new(id: u32) -> Self {\n        Agent { id: id + 1 }\n    }\n'
    )
    expect(r.report).toContain("kept 'pub'")
    await edit(file, [{ op: 'remove', symbol: 'Agent@3' }])
    expect(read(file).startsWith('impl Agent {')).toBe(true)
  })
})

describe.skipIf(!hasCodegraph)('with a codegraph index', () => {
  it('lists callers of a changed signature and the affected tests', { timeout: 60_000 }, async () => {
    const lib = put('src/greet.ts', 'export function greet(name: string): string {\n  return `hi ${name}`\n}\n')
    put('src/app.ts', "import { greet } from './greet'\n\nexport function main() {\n  return greet('a')\n}\n")
    put('src/greet.test.ts', "import { greet } from './greet'\n\ngreet('t')\n")
    execFileSync('git', ['init', '-q', tmp])
    execFileSync('codegraph', ['init', tmp], { stdio: 'ignore' })
    const r = await editFile(
      {
        file: lib,
        ops: [
          {
            op: 'replace',
            symbol: 'greet',
            code: 'export function greet(name: string, loud = false): string {\n  return loud ? name.toUpperCase() : `hi ${name}`\n}'
          }
        ]
      },
      { roots: [tmp] }
    )
    expect(r.report).toContain('signature changed: greet (name: string): string → (name: string, loud = false): string')
    expect(r.report).toMatch(/callers to check: src\/app\.ts:4/)
    expect(r.report).toMatch(/affected tests: .*src\/greet\.test\.ts/)
  })

  it('lists the nearest tests: direct importers, else one step further out', { timeout: 60_000 }, async () => {
    put('src/util.ts', "export const PREFIX = 'hi'\n")
    const greet = put(
      'src/greet.ts',
      "import { PREFIX } from './util'\n\nexport function greet(name: string): string {\n  return PREFIX + name\n}\n"
    )
    put('src/app.ts', "import { greet } from './greet'\n\nexport function main() {\n  return greet('a')\n}\n")
    put('src/greet.test.ts', "import { greet } from './greet'\n\ngreet('t')\n")
    put('src/app.test.ts', "import { main } from './app'\n\nmain()\n")
    execFileSync('git', ['init', '-q', tmp])
    execFileSync('codegraph', ['init', tmp], { stdio: 'ignore' })

    // app.test.ts reaches greet.ts only through app.ts: one step too far.
    const direct = await editFile(
      {
        file: greet,
        ops: [{ op: 'replace_in', symbol: 'greet', find: 'PREFIX + name', code: 'PREFIX + name.trim()' }]
      },
      { roots: [tmp] }
    )
    expect(direct.report).toMatch(/^affected tests: src\/greet\.test\.ts$/m)

    // No test imports util.ts itself, so the list steps out one level.
    const further = await editFile(
      { file: path.join(tmp, 'src/util.ts'), ops: [{ op: 'replace_in', find: "'hi'", code: "'hello'" }] },
      { roots: [tmp] }
    )
    expect(further.report).toMatch(/^affected tests: src\/greet\.test\.ts$/m)
  })

  it('still edits when the index cannot answer', { timeout: 60_000 }, async () => {
    const lib = put('src/greet.ts', 'export function greet(name: string): string {\n  return name\n}\n')
    put('src/app.ts', "import { greet } from './greet'\n\nexport function main() {\n  return greet('a')\n}\n")
    execFileSync('git', ['init', '-q', tmp])
    execFileSync('codegraph', ['init', tmp], { stdio: 'ignore' })
    const db = new DatabaseSync(path.join(tmp, '.codegraph', 'codegraph.db'))
    db.exec('DROP TABLE edges')
    db.close()
    const r = await editFile(
      {
        file: lib,
        ops: [
          {
            op: 'replace',
            symbol: 'greet',
            code: 'export function greet(name: string, n = 1): string {\n  return name\n}'
          }
        ]
      },
      { roots: [tmp] }
    )
    expect(r.written).toBe(true)
    expect(r.report).toContain('signature changed: greet')
    expect(read(lib)).toContain('n = 1')
  })
})
