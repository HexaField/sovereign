// The codegraph internals the analyzer uses: the standalone extractor and the
// WASM grammar loader. Both ship in codegraph's per-platform package and are
// not re-exported from its main entry, so they load by path.
//
// Load a file's grammar before extracting from it. codegraph's native kernel
// refuses any file it cannot parse, a syntax error or a gap in the grammar
// alike, and returns no symbols; with the WASM grammar loaded it falls back to
// an error-tolerant parse and still names them. The analyzer parses with the
// same grammars, so symbols and syntax verdicts come from one parser.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { EditError } from './types.js'
import type { SyntaxNode } from './languages.js'

const require = createRequire(import.meta.url)

/** A codegraph symbol, as `extractFromSource` returns it. Columns are JS string indices. */
export interface CgNode {
  kind: string
  name: string
  qualifiedName: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  signature?: string
}

export interface Tree {
  rootNode: SyntaxNode
  /** Frees the tree's WASM memory; trees are not garbage-collected. */
  delete(): void
}

interface Grammars {
  initGrammars(): Promise<void>
  loadGrammarsForLanguages(languages: string[]): Promise<void>
  isGrammarLoaded(language: string): boolean
  /** Null when the language has no grammar, or no tree-sitter parser (YAML, Vue). */
  getParser(language: string): { parse(text: string): Tree } | null
  /** 'unknown' when no language matches. */
  detectLanguage(path: string): string
}

interface Codegraph {
  extractFromSource(path: string, text: string): { nodes: CgNode[] }
  grammars: Grammars
}

let loaded: Codegraph | undefined
let initialised: Promise<void> | undefined

export function codegraph(): Codegraph {
  if (loaded) return loaded
  try {
    const sdk = require.resolve('@colbymchenry/codegraph')
    const lib = createRequire(sdk).resolve(
      `@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist/index.js`
    )
    const dir = join(dirname(lib), 'extraction')
    const { extractFromSource } = require(join(dir, 'index.js'))
    loaded = { extractFromSource, grammars: require(join(dir, 'grammars.js')) }
  } catch (err) {
    throw new EditError(
      `codegraph's extractor is unavailable on ${process.platform}-${process.arch}: ${(err as Error).message}`
    )
  }
  return loaded!
}

/** Load the grammar for `path`'s language, once per language. */
export async function loadGrammarFor(path: string): Promise<void> {
  const { grammars } = codegraph()
  await (initialised ??= grammars.initGrammars())
  const language = grammars.detectLanguage(path)
  if (language !== 'unknown' && !grammars.isGrammarLoaded(language)) {
    await grammars.loadGrammarsForLanguages([language])
  }
}
