// Syntax highlighting for diff lines via highlight.js.
// Lazily loads the library + language grammars on first use.

import type { HLJSApi } from 'highlight.js'

let hljs: HLJSApi | null = null
let loadPromise: Promise<HLJSApi> | null = null

/** Lazy-load highlight.js core + common languages. */
async function getHljs(): Promise<HLJSApi> {
  if (hljs) return hljs
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const mod = await import('highlight.js/lib/core')
    const h = mod.default

    // Register languages on demand — the common web/systems set
    const langs: Array<[string[], () => Promise<{ default: unknown }>]> = [
      [['typescript', 'ts', 'tsx', 'mts', 'cts'], () => import('highlight.js/lib/languages/typescript')],
      [['javascript', 'js', 'jsx', 'mjs', 'cjs'], () => import('highlight.js/lib/languages/javascript')],
      [['json', 'jsonc'], () => import('highlight.js/lib/languages/json')],
      [['css', 'scss', 'less'], () => import('highlight.js/lib/languages/css')],
      [['xml', 'html', 'svg', 'vue', 'svelte'], () => import('highlight.js/lib/languages/xml')],
      [['markdown', 'md'], () => import('highlight.js/lib/languages/markdown')],
      [['yaml', 'yml'], () => import('highlight.js/lib/languages/yaml')],
      [['bash', 'sh', 'zsh', 'fish'], () => import('highlight.js/lib/languages/bash')],
      [['python', 'py'], () => import('highlight.js/lib/languages/python')],
      [['rust', 'rs'], () => import('highlight.js/lib/languages/rust')],
      [['go'], () => import('highlight.js/lib/languages/go')],
      [['sql'], () => import('highlight.js/lib/languages/sql')],
      [['dockerfile'], () => import('highlight.js/lib/languages/dockerfile')],
      [['toml', 'ini'], () => import('highlight.js/lib/languages/ini')],
      [['diff', 'patch'], () => import('highlight.js/lib/languages/diff')],
      [['c', 'h'], () => import('highlight.js/lib/languages/c')],
      [['cpp', 'cc', 'cxx', 'hpp'], () => import('highlight.js/lib/languages/cpp')],
      [['java'], () => import('highlight.js/lib/languages/java')],
      [['ruby', 'rb'], () => import('highlight.js/lib/languages/ruby')],
      [['php'], () => import('highlight.js/lib/languages/php')],
      [['graphql', 'gql'], () => import('highlight.js/lib/languages/graphql')],
      [['swift'], () => import('highlight.js/lib/languages/swift')],
      [['kotlin', 'kt'], () => import('highlight.js/lib/languages/kotlin')],
      [['lua'], () => import('highlight.js/lib/languages/lua')],
      [['r'], () => import('highlight.js/lib/languages/r')],
      [['makefile'], () => import('highlight.js/lib/languages/makefile')],
      [['plaintext', 'txt'], () => import('highlight.js/lib/languages/plaintext')]
    ]

    // Register all languages eagerly — they're tiny grammar definitions
    await Promise.all(
      langs.map(async ([names, loader]) => {
        try {
          const langMod = await loader()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const langDef = langMod.default as any
          // Register under the first name, alias the rest
          h.registerLanguage(names[0], langDef)
          for (let i = 1; i < names.length; i++) {
            h.registerAliases(names[i], { languageName: names[0] })
          }
        } catch {
          // Language not available — skip silently
        }
      })
    )

    hljs = h
    return h
  })()
  return loadPromise
}

/** Map file extension to highlight.js language name. */
function extToLang(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext) return undefined

  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'xml',
    htm: 'xml',
    xml: 'xml',
    svg: 'xml',
    vue: 'xml',
    svelte: 'xml',
    md: 'markdown',
    mdx: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'bash',
    py: 'python',
    pyw: 'python',
    rs: 'rust',
    go: 'go',
    sql: 'sql',
    dockerfile: 'dockerfile',
    toml: 'ini',
    ini: 'ini',
    cfg: 'ini',
    diff: 'diff',
    patch: 'diff',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    java: 'java',
    rb: 'ruby',
    php: 'php',
    graphql: 'graphql',
    gql: 'graphql',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    lua: 'lua',
    r: 'r',
    makefile: 'makefile',
    txt: 'plaintext'
  }

  return map[ext]
}

/** Highlighted HTML cache — keyed by "lang:content" to avoid re-highlighting identical lines. */
const cache = new Map<string, string>()
const MAX_CACHE = 5000

/**
 * Highlight a single line of code. Returns an HTML string with <span> wrappers.
 * Returns the original content (HTML-escaped) when highlight.js has not loaded yet
 * or the language lacks a grammar.
 */
export function highlightLine(content: string, filePath: string): string {
  if (!hljs || !content) return escapeHtml(content)

  const lang = extToLang(filePath)
  if (!lang) return escapeHtml(content)

  // Check if the language has a registered grammar
  try {
    if (!hljs.getLanguage(lang)) return escapeHtml(content)
  } catch {
    return escapeHtml(content)
  }

  const key = `${lang}:${content}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  try {
    const result = hljs.highlight(content, { language: lang, ignoreIllegals: true })
    const html = result.value

    // Evict oldest entries when cache grows too large
    if (cache.size >= MAX_CACHE) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
    cache.set(key, html)
    return html
  } catch {
    return escapeHtml(content)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Kick off the lazy load. Call early so grammars are ready by the time diffs render. */
export function preloadHighlighter(): void {
  getHljs()
}

/** Signal-compatible: returns true once hljs has loaded. */
export function highlighterReady(): boolean {
  return hljs !== null
}

/** @internal — reset module state for testing. */
export function _resetForTest(): void {
  hljs = null
  loadPromise = null
  cache.clear()
}

/** @internal — expose for testing. */
export { getHljs as _getHljs, extToLang as _extToLang }
