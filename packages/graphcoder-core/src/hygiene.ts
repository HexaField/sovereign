// Edge hygiene: which index edges are real dependencies.
//
// Name-resolved edges pollute coupling badly. Measured on ad4m: `core/src`
// showed 2,187 "calls" into a test runner (every `describe`/`expect` bound by
// name at confidence 0.4), and Rust std methods (`clone`, `collect`, `push`)
// bound to local definitions even at 0.9. Hygiene took module links from 576
// to 432 and cycles from 399 to 36. Every map, rule and reach count reads
// edges through this filter first.

import type { GraphEdge, GraphNode } from './graph.js'

/** Kinds of edge that state a dependency; `contains`, `exports`, `type_of`, … do not */
export const DEPENDENCY_EDGE_KINDS: ReadonlySet<string> = new Set([
  'imports',
  'calls',
  'references',
  'instantiates',
  'extends',
  'implements',
  'decorates'
])

/** Resolver confidence below which an edge is a guess */
export const MIN_CONFIDENCE = 0.85

/** Resolvers that bind by import path: trustworthy even for common names. A qualified-name match is not — `Foo::default()` still binds by method name alone. */
const PRECISE_RESOLVERS = new Set(['import', 'function-ref'])

/** Resolvers that bind by name alone, with no import path or qualified path behind the match */
const NAME_ONLY_RESOLVERS = new Set(['exact-match', 'fuzzy'])

/** Names that name-based resolution binds to the wrong definition far more often than the right one */
export const COMMON_NAMES: ReadonlySet<string> = new Set(
  [
    // test globals
    'describe',
    'it',
    'test',
    'expect',
    'beforeEach',
    'afterEach',
    'beforeAll',
    'afterAll',
    'assert',
    'vi',
    'jest',
    // std / collection / conversion methods (Rust and JS)
    'new',
    'default',
    'from',
    'into',
    'try_from',
    'try_into',
    'clone',
    'to_owned',
    'to_string',
    'as_str',
    'as_ref',
    'len',
    'is_empty',
    'push',
    'pop',
    'insert',
    'remove',
    'get',
    'get_mut',
    'set',
    'has',
    'add',
    'delete',
    'clear',
    'contains',
    'iter',
    'into_iter',
    'map',
    'filter',
    'find',
    'collect',
    'unwrap',
    'unwrap_or',
    'expect_err',
    'ok',
    'err',
    'next',
    'keys',
    'values',
    'entries',
    'join',
    'split',
    'replace',
    'drain',
    'flatten',
    'parse',
    'fmt',
    'eq',
    'cmp',
    'hash',
    'send',
    'recv',
    'lock',
    'read',
    'write',
    'open',
    'close',
    'run',
    'start',
    'stop',
    'init',
    'call',
    'apply',
    'bind',
    'then',
    'catch',
    'finally',
    'emit',
    'on',
    'off',
    'forEach',
    'reduce',
    'some',
    'every',
    'slice',
    'concat',
    'includes',
    'indexOf',
    'toString',
    'valueOf',
    'toJSON',
    'log',
    'error',
    'warn',
    'info',
    'debug',
    'trace',
    'Ok',
    'Err',
    'Some',
    'None',
    'Result',
    'Option',
    'Vec',
    'String',
    'Number',
    'Boolean',
    'Bool',
    'take',
    'Box',
    'Arc',
    'Mutex',
    'Value',
    'Error',
    // macros, codec and builder methods, trait names, callback parameters
    'json',
    'encode',
    'decode',
    'finish',
    'drop',
    'fn'
  ].map((n) => n.toLowerCase())
)

/** Paths that hold only test code */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|test-support|sweettest)\/|[^/]_(tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|(_tests?|_e2e|_test_support|test_utils)\.rs$|(^|\/)tests?\.rs$/

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

/** 1-based line ranges of inline test code per file, e.g. Rust `#[cfg(test)] mod tests { … }` */
export type TestRanges = Map<string, Array<[number, number]>>

/** The package (nearest manifest) a file belongs to */
export interface PackageInfo {
  name: string
  /** Names of the packages its manifest depends on */
  deps: string[]
}

/** Why edge hygiene drops an edge */
export type EdgeRejection =
  | 'edge-kind'
  | 'low-confidence'
  | 'enum-member'
  | 'common-name'
  | 'test-code'
  | 'undeclared-package'
  | 'shadowed-import'

export interface EdgeHygieneOptions {
  testRanges?: TestRanges
  /** File → owning package; an edge between packages counts only when the source manifest declares the target */
  packages?: Map<string, PackageInfo>
  /**
   * The `import` nodes that say which names each file imports, when not the graph's own. In semantic-id space the
   * same import statement in several files merges into one node, so a diff check passes the unmerged ones.
   */
  importNodes?: GraphNode[]
  /**
   * A source whose test code still counts. A module made only of test files depends on what it tests, so the
   * module map exempts such modules; by default test code never counts.
   */
  keepTestSource?: (source: GraphNode) => boolean
}

export interface EdgeHygiene {
  /**
   * Why hygiene drops the edge, or null when it passes (also when an end is not in the graph). `planned`: an edge
   * someone asserts by semantic id (an ArchDiff edge with no resolver metadata) — no name-resolution checks apply,
   * only kind and test code.
   */
  reject(edge: GraphEdge, options?: { planned?: boolean }): EdgeRejection | null
  /** The edges that pass, both ends in the graph */
  trusted(edges: Iterable<GraphEdge>): GraphEdge[]
}

const normalizePackage = (name: string) => name.replace(/_/g, '-')

/**
 * The identifiers a Rust `use` or a JS/TS `import` statement binds in its file. Aliases bind the alias; globs,
 * namespace imports and `self` bind no single name.
 */
export function importedNames(statement: string): string[] {
  const names: string[] = []
  const add = (raw: string) => {
    const name = raw.trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !['self', 'super', 'crate'].includes(name)) names.push(name)
  }
  const rust = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\s\S]*?);?\s*$/.exec(statement)
  if (rust) {
    const body = rust[1].replace(/([\w$]+)\s+as\s+([\w$]+)/g, '$2')
    for (const piece of body.split(/[{},]/)) add(piece.trim().split('::').pop() ?? '')
    return names
  }
  const js = /^\s*import\s+(?:type\s+)?([\s\S]*?)\s+from\s*["']/.exec(statement)
  if (!js) return names
  const clause = js[1]
  const braces = /\{([\s\S]*)\}/.exec(clause)
  for (const spec of braces?.[1].split(',') ?? []) {
    const parts = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/)
    add(parts[parts.length - 1])
  }
  const head = clause.replace(/\{[\s\S]*\}/, '').split(',')[0]
  if (!head.includes('*')) add(head)
  return names
}

/** An import source that names a package other than `target` (relative paths and `crate`/`self`/`super` are local) */
function sourceIsOtherPackage(source: string, target: PackageInfo): boolean {
  if (source.startsWith('.') || ['crate', 'self', 'super'].includes(source)) return false
  // Bare Rust crate name, or a JS package spec; anything else (e.g. a `@/` path alias) may be local
  if (/^[A-Za-z_]\w*$/.test(source)) return normalizePackage(source) !== normalizePackage(target.name)
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/|$)/i.test(source)) return false
  return source !== target.name && !source.startsWith(`${target.name}/`)
}

/** An import path (`refName`) that names a package other than the one it resolved into: a binding by name alone */
function importNamesOtherPackage(ref: unknown, target: PackageInfo): boolean {
  if (typeof ref !== 'string' || ref.startsWith('.')) return false
  if (ref.includes('::')) {
    const head = ref.split('::')[0]
    return ['crate', 'self', 'super'].includes(head) || normalizePackage(head) !== normalizePackage(target.name)
  }
  if (ref.startsWith('@') || ref.includes('/')) return ref !== target.name && !ref.startsWith(`${target.name}/`)
  return false
}

/** The resolver checks: kind, confidence, enum variants, common names */
function resolverRejection(edge: GraphEdge, target: GraphNode): EdgeRejection | null {
  if (!DEPENDENCY_EDGE_KINDS.has(edge.kind)) return 'edge-kind'
  const meta = edge.metadata ?? {}
  const confidence = typeof meta['confidence'] === 'number' ? meta['confidence'] : null
  if (confidence === null) return edge.kind === 'imports' ? null : 'low-confidence'
  if (confidence < MIN_CONFIDENCE) return 'low-confidence'
  const resolvedBy = typeof meta['resolvedBy'] === 'string' ? meta['resolvedBy'] : ''
  // A bare `Json(…)` or `Tool` matched to some enum's variant by name is almost never that variant
  if (NAME_ONLY_RESOLVERS.has(resolvedBy) && target.kind === 'enum_member') return 'enum-member'
  return PRECISE_RESOLVERS.has(resolvedBy) || !COMMON_NAMES.has(target.name.toLowerCase()) ? null : 'common-name'
}

/**
 * Edge hygiene over one graph. Rules, in order: a dependency kind; confidence ≥ 0.85 (no confidence passes only
 * for `imports`); no name-only match onto an enum variant; no common name unless an import path bound it; no
 * test code (test files, inline test ranges); no edge into a package the source manifest does not declare; no
 * name-only match onto a symbol whose name the source file imports from another package. An import into a package
 * the manifest declares skips the resolver checks: the manifest vouches for it.
 */
export function createEdgeHygiene(nodes: readonly GraphNode[], options: EdgeHygieneOptions = {}): EdgeHygiene {
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const packageOf = (n: GraphNode) => options.packages?.get(n.filePath)

  const inTestRange = (file: string, line: number | undefined): boolean =>
    line !== undefined && (options.testRanges?.get(file) ?? []).some(([a, b]) => line >= a && line <= b)
  const testCode = (s: GraphNode, e: GraphEdge): boolean =>
    !options.keepTestSource?.(s) &&
    (isTestPath(s.filePath) || inTestRange(s.filePath, e.line ?? (s.kind === 'file' ? undefined : s.startLine)))

  const declared = new Map<PackageInfo, Set<string>>()
  const declares = (sp: PackageInfo, tp: PackageInfo): boolean => {
    let deps = declared.get(sp)
    if (!deps) declared.set(sp, (deps = new Set(sp.deps.map(normalizePackage))))
    return deps.has(normalizePackage(tp.name))
  }
  const crossesUndeclared = (s: GraphNode, t: GraphNode, e: GraphEdge): boolean => {
    const sp = packageOf(s)
    const tp = packageOf(t)
    if (!sp || !tp || sp === tp) return false
    const ref = e.metadata?.['refName']
    // A relative import binds by path, whatever the manifests say
    if (e.kind === 'imports' && typeof ref === 'string' && ref.startsWith('.')) return false
    if (e.kind === 'imports' && importNamesOtherPackage(ref, tp)) return true
    return !declares(sp, tp)
  }
  const declaredPackageImport = (s: GraphNode, t: GraphNode, e: GraphEdge): boolean => {
    if (e.kind !== 'imports') return false
    const sp = packageOf(s)
    const tp = packageOf(t)
    if (!sp || !tp || sp === tp || importNamesOtherPackage(e.metadata?.['refName'], tp)) return false
    return declares(sp, tp)
  }

  // file → name → the import source that binds it (an `import` node's `name` is its source)
  const importsByFile = new Map<string, Map<string, string>>()
  if (options.packages) {
    for (const n of options.importNodes ?? nodes) {
      if (n.kind !== 'import' || !n.signature) continue
      let bound = importsByFile.get(n.filePath)
      if (!bound) importsByFile.set(n.filePath, (bound = new Map()))
      for (const name of importedNames(n.signature)) bound.set(name, n.name)
    }
  }
  const shadowedByImport = (s: GraphNode, t: GraphNode, e: GraphEdge): boolean => {
    const resolvedBy = e.metadata?.['resolvedBy']
    if (typeof resolvedBy !== 'string' || !NAME_ONLY_RESOLVERS.has(resolvedBy)) return false
    const source = importsByFile.get(s.filePath)?.get(t.name)
    const tp = packageOf(t)
    return source !== undefined && tp !== undefined && sourceIsOtherPackage(source, tp)
  }

  const reject = (e: GraphEdge, { planned = false } = {}): EdgeRejection | null => {
    const s = nodeById.get(e.source)
    const t = nodeById.get(e.target)
    if (!s || !t) return null
    if (planned) {
      if (!DEPENDENCY_EDGE_KINDS.has(e.kind)) return 'edge-kind'
      return testCode(s, e) ? 'test-code' : null
    }
    const resolver = declaredPackageImport(s, t, e) ? null : resolverRejection(e, t)
    if (resolver) return resolver
    if (testCode(s, e)) return 'test-code'
    if (crossesUndeclared(s, t, e)) return 'undeclared-package'
    return shadowedByImport(s, t, e) ? 'shadowed-import' : null
  }

  return {
    reject,
    trusted: (edges) => {
      const out: GraphEdge[] = []
      for (const e of edges) if (nodeById.has(e.source) && nodeById.has(e.target) && !reject(e)) out.push(e)
      return out
    }
  }
}
