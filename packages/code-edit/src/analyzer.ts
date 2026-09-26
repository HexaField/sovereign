// codegraph names the symbols; its tree-sitter grammar finds each one's whole
// declaration and judges the syntax. Every language codegraph parses gets the
// syntax check; the ones with a profile (TS/JS, Python, Rust, Go) also widen
// spans to the full declaration. Other languages use codegraph's spans as-is.

import { lineEnd, lineStart, startsLine } from './text.js'
import type { Analysis, Analyzer, Declaration, SyntaxProblem } from './types.js'
import { codegraph, loadGrammarFor, type CgNode } from './codegraph.js'
import { GENERIC_TRAITS, profileFor, type LanguageProfile, type SyntaxNode } from './languages.js'

const NOT_SYMBOLS = new Set(['file', 'import', 'export', 'parameter'])
const MAX_PROBLEMS = 200

export function createAnalyzer(): Analyzer {
  return { prepare: loadGrammarFor, analyze }
}

function analyze(path: string, text: string): Analysis {
  const { extractFromSource, grammars } = codegraph()
  const language = grammars.detectLanguage(path)
  const tree = grammars.isGrammarLoaded(language) ? grammars.getParser(language)?.parse(text) : undefined
  try {
    return analyzeTree(path, text, profileFor(language), tree?.rootNode, extractFromSource)
  } finally {
    tree?.delete()
  }
}

function analyzeTree(
  path: string,
  text: string,
  profile: LanguageProfile | undefined,
  root: SyntaxNode | undefined,
  extract: (path: string, text: string) => { nodes: CgNode[] }
): Analysis {
  const lines = lineStarts(text)
  const offset = (line: number, column: number) => Math.min((lines[line - 1] ?? text.length) + column, text.length)
  const nodes = extract(path, text).nodes.filter((n) => !NOT_SYMBOLS.has(n.kind))
  const spans = nodes.map((n) => ({ start: offset(n.startLine, n.startColumn), end: offset(n.endLine, n.endColumn) }))
  const lineAt = (o: number) => upperBound(lines, o)

  const declarations = nodes.map((n, i): Declaration => {
    const region =
      root && profile
        ? widen(root, profile, text, spans, i, n.name)
        : { end: spans[i].end, triviaStart: spans[i].start, headStart: spans[i].start }
    const end = region.end
    return {
      name: n.name,
      qualifiedName: n.qualifiedName,
      kind: n.kind,
      ...(n.signature ? { signature: n.signature } : {}),
      ...(region.overloadStart !== undefined ? { overloadStart: region.overloadStart } : {}),
      triviaStart: region.triviaStart,
      ...(region.decoratorStart !== undefined ? { decoratorStart: region.decoratorStart } : {}),
      headStart: region.headStart,
      ...(region.exportPrefix ? { exportPrefix: region.exportPrefix } : {}),
      ...(region.value ? { value: region.value } : {}),
      end,
      startLine: lineAt(region.overloadStart ?? region.triviaStart),
      line: lineAt(region.headStart),
      endLine: lineAt(Math.max(region.headStart, end - 1))
    }
  })

  const strictError = profile?.validate?.(text)
  return {
    checked: root !== undefined,
    syntaxErrors: root?.hasError ? problems(root, text) : [],
    ...(strictError !== undefined ? { strictError } : {}),
    declarations,
    traits: profile?.traits ?? GENERIC_TRAITS
  }
}

interface Region {
  end: number
  overloadStart?: number
  triviaStart: number
  decoratorStart?: number
  headStart: number
  exportPrefix?: string
  value?: { start: number; end: number }
}

/** Comments that belong to the file or module, never to the declaration below: a shebang, Rust inner docs. */
const FILE_COMMENT = /^(?:#!|\/\/!|\/\*!)/

function widen(
  root: SyntaxNode,
  profile: LanguageProfile,
  text: string,
  spans: Array<{ start: number; end: number }>,
  i: number,
  name: string
): Region {
  const { start: s, end: e } = spans[i]
  let core = root.namedDescendantForIndex(s, Math.max(s, e - 1))
  while (core.parent && (core.startIndex > s || core.endIndex < e)) core = core.parent
  // codegraph and the grammar disagree about this symbol: trust codegraph's span.
  if (core === root || !core.parent) return { end: e, triviaStart: s, headStart: s }

  const holdsOther = (n: SyntaxNode, inner: SyntaxNode) =>
    spans.some(
      (o, j) =>
        j !== i &&
        o.start >= n.startIndex &&
        o.start < n.endIndex &&
        !(o.start >= inner.startIndex && o.start < inner.endIndex)
    )
  let outer = core
  for (let p = outer.parent; p && isWrapper(profile, p) && !holdsOther(p, outer); p = outer.parent) outer = p

  const trivia = (n: SyntaxNode) => profile.comments.has(n.type) || profile.decorators.has(n.type)
  let decoratorStart: number | undefined
  let headStart = outer.startIndex
  for (const child of outer.children) {
    if (!trivia(child)) {
      headStart = child.startIndex
      break
    }
    if (profile.decorators.has(child.type)) decoratorStart ??= child.startIndex
  }

  // Comments and decorators directly above, each starting its line; above those,
  // any overload signatures and their comments. A blank line detaches a comment
  // (a section header), never a decorator or overload: those belong to what follows.
  let triviaStart = outer.startIndex
  let below = outer.startIndex
  let overloaded = false
  for (let sib = siblingAbove(outer); sib; sib = sib.previousNamedSibling) {
    const overload = profile.overload?.(sib, name) ?? false
    const gap = text.slice(sib.endIndex, below)
    // A decorator may share its line with the decorators before it (`@A() @B()`).
    const prev = sib.previousNamedSibling
    const afterDecorator =
      profile.decorators.has(sib.type) &&
      prev !== null &&
      profile.decorators.has(prev.type) &&
      /^[ \t]*$/.test(text.slice(prev.endIndex, sib.startIndex))
    if (
      !(overload || trivia(sib)) ||
      gap.trim() ||
      (profile.comments.has(sib.type) && /\n[ \t]*\n/.test(gap)) ||
      !(startsLine(text, sib.startIndex) || afterDecorator) ||
      FILE_COMMENT.test(sib.text)
    )
      break
    below = sib.startIndex
    overloaded ||= overload
    if (overloaded) continue
    triviaStart = below
    if (profile.decorators.has(sib.type)) decoratorStart = below
  }

  const valueHeld = profile.values?.has(core.type) && core.parent?.type === 'variable_declarator'
  return {
    end: codeEnd(outer, profile.comments, text),
    ...(overloaded ? { overloadStart: below } : {}),
    triviaStart,
    ...(decoratorStart !== undefined ? { decoratorStart } : {}),
    headStart,
    exportPrefix: profile.exportPrefix?.(outer, headStart, text),
    ...(valueHeld ? { value: { start: core.startIndex, end: codeEnd(core, profile.comments, text) } } : {})
  }
}

/**
 * The named sibling above `node`. A Python block starts at its first statement
 * and keeps the comments above that statement outside itself, so when a node
 * opens its parent, look above the parent.
 */
function siblingAbove(node: SyntaxNode): SyntaxNode | null {
  let n = node
  while (!n.previousNamedSibling && n.parent && n.parent.startIndex === n.startIndex) n = n.parent
  return n.previousNamedSibling
}

/**
 * Where a declaration's code ends. Grammars tuck a same-line trailing comment
 * into the node (`} // done`, `const x = 1 // why`). It stays outside when it
 * follows a closing bracket or a one-line declaration; after the last
 * statement of a body (`    return 1  # one`) it belongs to that statement.
 */
function codeEnd(node: SyntaxNode, comments: ReadonlySet<string>, text: string): number {
  const end = lastToken(node, comments)
  const code = text.slice(node.startIndex, end)
  return /[}\])];?$/.test(code) || !code.includes('\n') ? end : node.endIndex
}

function lastToken(node: SyntaxNode, comments: ReadonlySet<string>): number {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i]
    if (!comments.has(child.type)) return child.children.length ? lastToken(child, comments) : child.endIndex
  }
  return node.endIndex
}

function isWrapper(profile: LanguageProfile, node: SyntaxNode): boolean {
  if (!profile.wrappers.has(node.type)) return false
  const only = profile.single?.[node.type]
  return !only || node.namedChildren.filter((c) => only.includes(c.type)).length === 1
}

/**
 * Every ERROR and MISSING node, in file order. The key holds the problem's own
 * text and its line's text, not its position, so a problem that an edit
 * elsewhere only moves keeps its key.
 */
function problems(root: SyntaxNode, text: string): SyntaxProblem[] {
  const out: SyntaxProblem[] = []
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  const visit = (node: SyntaxNode) => {
    if (out.length >= MAX_PROBLEMS) return
    if (node.isMissing || node.type === 'ERROR') {
      const message = node.isMissing ? `missing '${node.type}'` : 'syntax error'
      const lineText = text.slice(lineStart(text, node.startIndex), lineEnd(text, node.startIndex))
      out.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        message,
        key: `${message}|${squash(node.text).slice(0, 80)}|${squash(lineText)}`
      })
      return
    }
    for (const child of node.children) if (child.hasError || child.isMissing) visit(child)
  }
  visit(root)
  return out
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** 1-based line holding `offset`. */
function upperBound(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= offset) lo = mid + 1
    else hi = mid
  }
  return lo
}
