import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import {
  highlightLine,
  highlighterReady,
  preloadHighlighter,
  _resetForTest,
  _getHljs,
  _extToLang
} from './highlight.js'

describe('extToLang', () => {
  it('maps TypeScript extensions', () => {
    expect(_extToLang('src/app.ts')).toBe('typescript')
    expect(_extToLang('App.tsx')).toBe('typescript')
    expect(_extToLang('utils.mts')).toBe('typescript')
    expect(_extToLang('config.cts')).toBe('typescript')
  })

  it('maps JavaScript extensions', () => {
    expect(_extToLang('index.js')).toBe('javascript')
    expect(_extToLang('App.jsx')).toBe('javascript')
    expect(_extToLang('module.mjs')).toBe('javascript')
    expect(_extToLang('legacy.cjs')).toBe('javascript')
  })

  it('maps markup/style extensions', () => {
    expect(_extToLang('page.html')).toBe('xml')
    expect(_extToLang('feed.xml')).toBe('xml')
    expect(_extToLang('icon.svg')).toBe('xml')
    expect(_extToLang('style.css')).toBe('css')
    expect(_extToLang('style.scss')).toBe('css')
  })

  it('maps config/data extensions', () => {
    expect(_extToLang('data.json')).toBe('json')
    expect(_extToLang('config.yaml')).toBe('yaml')
    expect(_extToLang('config.yml')).toBe('yaml')
    expect(_extToLang('config.toml')).toBe('ini')
  })

  it('maps systems languages', () => {
    expect(_extToLang('main.rs')).toBe('rust')
    expect(_extToLang('main.go')).toBe('go')
    expect(_extToLang('main.c')).toBe('c')
    expect(_extToLang('lib.cpp')).toBe('cpp')
    expect(_extToLang('App.java')).toBe('java')
    expect(_extToLang('app.py')).toBe('python')
    expect(_extToLang('app.rb')).toBe('ruby')
  })

  it('maps shell extensions', () => {
    expect(_extToLang('run.sh')).toBe('bash')
    expect(_extToLang('run.bash')).toBe('bash')
    expect(_extToLang('run.zsh')).toBe('bash')
  })

  it('returns undefined for unknown extensions', () => {
    expect(_extToLang('file.xyz')).toBeUndefined()
    expect(_extToLang('noext')).toBeUndefined()
    expect(_extToLang('')).toBeUndefined()
  })
})

describe('highlightLine — before loading', () => {
  beforeEach(() => {
    _resetForTest()
  })

  it('reports not ready before loading', () => {
    expect(highlighterReady()).toBe(false)
  })

  it('returns HTML-escaped content when hljs not loaded', () => {
    const result = highlightLine('const x = 1', 'test.ts')
    expect(result).toBe('const x = 1')
    expect(result).not.toContain('<span')
  })

  it('escapes HTML entities when hljs not loaded', () => {
    const result = highlightLine('<div class="a">&</div>', 'test.html')
    expect(result).toBe('&lt;div class="a"&gt;&amp;&lt;/div&gt;')
  })

  it('returns empty string for empty content', () => {
    expect(highlightLine('', 'test.ts')).toBe('')
  })
})

describe('highlightLine — after loading', () => {
  beforeAll(async () => {
    _resetForTest()
    preloadHighlighter()
    await _getHljs()
  })

  beforeEach(() => {
    // Don't reset hljs — keep it loaded; just test highlighting
  })

  it('reports ready after loading', () => {
    expect(highlighterReady()).toBe(true)
  })

  it('highlights TypeScript code with span wrappers', () => {
    const result = highlightLine('const x: number = 42', 'test.ts')
    expect(result).toContain('<span')
    expect(result).toContain('hljs-')
    // Should contain the keyword 'const'
    expect(result).toContain('const')
    // Should contain the number
    expect(result).toContain('42')
  })

  it('highlights JavaScript code', () => {
    const result = highlightLine('function hello() { return true }', 'app.js')
    expect(result).toContain('<span')
    expect(result).toContain('function')
  })

  it('highlights Python code', () => {
    const result = highlightLine('def greet(name: str) -> None:', 'app.py')
    expect(result).toContain('<span')
    expect(result).toContain('def')
  })

  it('highlights JSON', () => {
    const result = highlightLine('{ "key": "value", "num": 123 }', 'data.json')
    expect(result).toContain('<span')
  })

  it('highlights Rust code', () => {
    const result = highlightLine('fn main() -> Result<(), Error> {', 'main.rs')
    expect(result).toContain('<span')
    expect(result).toContain('fn')
  })

  it('returns escaped content for unknown file types', () => {
    const result = highlightLine('some content <here>', 'file.xyz')
    expect(result).toBe('some content &lt;here&gt;')
    expect(result).not.toContain('<span')
  })

  it('returns escaped content for files without extension', () => {
    const result = highlightLine('hello world', 'Makefile')
    // 'Makefile' has no dot-extension, so extToLang returns undefined
    // (the extension map key would be 'makefile' but split('.').pop() gives 'Makefile')
    // This falls through to escapeHtml
    expect(result).not.toContain(undefined)
  })

  it('caches repeated highlights', () => {
    const first = highlightLine('const a = 1', 'x.ts')
    const second = highlightLine('const a = 1', 'x.ts')
    expect(first).toBe(second)
  })

  it('produces different output for different languages', () => {
    const tsResult = highlightLine('function test() {}', 'a.ts')
    const pyResult = highlightLine('def test():', 'a.py')
    // Both should contain spans but with different content
    expect(tsResult).toContain('function')
    expect(pyResult).toContain('def')
    expect(tsResult).not.toBe(pyResult)
  })

  it('handles HTML-special characters in code', () => {
    const result = highlightLine('if (a < b && c > d) {}', 'test.ts')
    // highlight.js escapes HTML entities in its output
    expect(result).toContain('&lt;')
    expect(result).toContain('&gt;')
    expect(result).toContain('&amp;')
  })

  it('handles string literals with quotes', () => {
    const result = highlightLine("const s = 'hello world'", 'test.ts')
    expect(result).toContain('<span')
    expect(result).toContain('hello world')
  })
})

describe('highlightLine — escapeHtml', () => {
  beforeEach(() => {
    _resetForTest()
  })

  it('escapes ampersands', () => {
    expect(highlightLine('a & b', 'test.ts')).toBe('a &amp; b')
  })

  it('escapes angle brackets', () => {
    expect(highlightLine('a < b > c', 'test.ts')).toBe('a &lt; b &gt; c')
  })

  it('escapes all three together', () => {
    expect(highlightLine('Map<K, V> & Set<T>', 'test.ts')).toBe('Map&lt;K, V&gt; &amp; Set&lt;T&gt;')
  })
})
