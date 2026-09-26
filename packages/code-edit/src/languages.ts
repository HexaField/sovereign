// Per-language knowledge the analyzer needs to turn a codegraph symbol into
// a whole declaration: which tree-sitter nodes wrap a declaration without
// being a container, what sits attached above one, and what counts as
// visibility that replacement code keeps. Keyed by codegraph's language ids.

import { spawnSync } from 'node:child_process'
import type { LanguageTraits, SyntaxProblem } from './types.js'

/** The slice of a tree-sitter node the analyzer reads. */
export interface SyntaxNode {
  type: string
  text: string
  startIndex: number
  endIndex: number
  startPosition: { row: number; column: number }
  hasError: boolean
  isMissing: boolean
  parent: SyntaxNode | null
  children: SyntaxNode[]
  namedChildren: SyntaxNode[]
  previousNamedSibling: SyntaxNode | null
  childForFieldName(name: string): SyntaxNode | null
  namedDescendantForIndex(start: number, end: number): SyntaxNode
}

export interface LanguageProfile {
  /** A stricter syntax check than the grammar's: a problem, null when clean, undefined when unavailable. */
  validate?: (text: string) => SyntaxProblem | null | undefined
  traits: LanguageTraits
  /** Node types that wrap a declaration without being a container. */
  wrappers: ReadonlySet<string>
  /** Wrappers that count only while they hold one child of these types (`const a = 1, b = 2`). */
  single?: Readonly<Record<string, readonly string[]>>
  /** Comment node types. With decorators, what attaches above a declaration. */
  comments: ReadonlySet<string>
  /** Decorator or attribute node types. */
  decorators: ReadonlySet<string>
  /** True for a sibling above a declaration that is one of its overload signatures. */
  overload?: (node: SyntaxNode, name: string) => boolean
  /** Value node types: a function or class assigned to a variable. */
  values?: ReadonlySet<string>
  /** Visibility text replacement code keeps when it omits it. */
  exportPrefix?: (outer: SyntaxNode, headStart: number, text: string) => string | undefined
}

const TS_TRAITS: LanguageTraits = {
  comment: ['//', '/*'],
  decorator: ['@'],
  exported: /^export\b/,
  statement: /^(?:export|declare|const|let|var)\b/,
  declaration:
    /^(?:(?:async\s+)?function\b|(?:abstract\s+)?class\b|(?:interface|type|enum|const|let|var|namespace|module|declare|default)\b)/
}

// Also serves plain JavaScript and JSX: the node types these rules use are shared.
const typescript: LanguageProfile = {
  traits: TS_TRAITS,
  wrappers: new Set([
    'export_statement',
    'ambient_declaration',
    'lexical_declaration',
    'variable_declaration',
    'variable_declarator',
    'expression_statement',
    'enum_assignment'
  ]),
  single: { lexical_declaration: ['variable_declarator'], variable_declaration: ['variable_declarator'] },
  comments: new Set(['comment']),
  decorators: new Set(['decorator']),
  overload: (node, name) => {
    const sig = node.type === 'export_statement' ? node.childForFieldName('declaration') : node
    return (
      (sig?.type === 'function_signature' || sig?.type === 'method_signature') &&
      sig.childForFieldName('name')?.text === name
    )
  },
  values: new Set(['arrow_function', 'function_expression', 'function', 'generator_function', 'class']),
  exportPrefix: (outer, headStart, text) => {
    if (outer.type !== 'export_statement') return undefined
    const inner = outer.childForFieldName('declaration') ?? outer.childForFieldName('value')
    return inner ? text.slice(headStart, inner.startIndex).replace(/\s+/g, ' ') : undefined
  }
}

// tree-sitter-python accepts bad indentation (a def with no indented body,
// an unindent to no outer level); CPython's parser does not.
const PY_CHECK = [
  'import ast, sys',
  'try:',
  '    ast.parse(sys.stdin.read())',
  'except SyntaxError as e:',
  '    print(f"{e.lineno}:{e.offset or 1}:{type(e).__name__}: {e.msg}")'
].join('\n')
let pythonMissing = false

function pythonSyntax(text: string): SyntaxProblem | null | undefined {
  if (pythonMissing) return undefined
  const r = spawnSync('python3', ['-c', PY_CHECK], { input: text, encoding: 'utf8', timeout: 10_000 })
  if (r.error || r.status !== 0) {
    // Only a missing interpreter switches the check off; a timeout skips this one file.
    pythonMissing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    return undefined
  }
  const m = /^(\d+):(\d+):(.*)$/.exec(r.stdout.trim())
  if (!m) return null
  const [, line, column, message] = m
  const lineText = text.split('\n')[Number(line) - 1] ?? ''
  return { line: Number(line), column: Number(column) - 1, message, key: `${message}|${lineText.trim()}` }
}

const python: LanguageProfile = {
  validate: pythonSyntax,
  traits: { comment: ['#'], decorator: ['@'] },
  wrappers: new Set(['decorated_definition', 'expression_statement']),
  comments: new Set(['comment']),
  decorators: new Set(['decorator'])
}

const rust: LanguageProfile = {
  traits: {
    comment: ['//', '/*'],
    decorator: ['#['],
    exported: /^pub\b/,
    declaration:
      /^(?:(?:async|const|unsafe|extern(?:\s+"[^"]*")?)\s+)*(?:fn|struct|enum|trait|impl|type|const|static|mod|union|macro_rules!)\b/
  },
  wrappers: new Set(['const_item', 'static_item', 'enum_variant']),
  comments: new Set(['line_comment', 'block_comment']),
  decorators: new Set(['attribute_item']),
  exportPrefix: (outer) => {
    const vis = outer.namedChildren.find((c) => c.type === 'visibility_modifier')
    return vis ? `${vis.text} ` : undefined
  }
}

const go: LanguageProfile = {
  traits: { comment: ['//', '/*'], decorator: [] },
  wrappers: new Set(['type_declaration', 'var_declaration', 'const_declaration']),
  single: {
    type_declaration: ['type_spec', 'type_alias'],
    var_declaration: ['var_spec'],
    const_declaration: ['const_spec']
  },
  comments: new Set(['comment']),
  decorators: new Set()
}

const BY_LANGUAGE: Record<string, LanguageProfile> = {
  typescript,
  tsx: typescript,
  javascript: typescript,
  jsx: typescript,
  python,
  rust,
  go
}

/** Traits for files no grammar covers: every common comment and decorator token. */
export const GENERIC_TRAITS: LanguageTraits = { comment: ['//', '/*', '#'], decorator: ['@'] }

export function profileFor(language: string): LanguageProfile | undefined {
  return BY_LANGUAGE[language]
}
