// The code → concept map: which concept page each file and symbol belongs to,
// read from the pages' claims (tree.ts), and the scripted checks on it.
//
// D7 (decided 2026-10-21): when several pages claim a file, the deepest page
// owns it; files claimed by unrelated pages (neither an ancestor of the
// other) are reported for the authors to resolve. A symbol a page names in
// backticks stays with that page, whoever owns its file.

import type {
  ConceptCoverage,
  ConceptDependency,
  ConceptMapReport,
  ConceptNode,
  SharedClaim,
  StaleClaim
} from '../contract.js'
import { byCodeUnit } from '../diff/compute.js'
import type { GraphEdge, GraphNode } from '../graph.js'
import type { EdgeHygiene } from '../hygiene.js'
import { isSymbol } from '../structure/changes.js'
import { isAncestor, type ConceptPage, type ConceptTree, type SymbolClaim } from './tree.js'

/** Where a node sits: enough to place it */
export type Placed = Pick<GraphNode, 'filePath' | 'startLine' | 'endLine'>

/** A page claiming a file, through its narrowest claim that covers the file */
export interface Claimant {
  page: string
  /** The claimed path: the file itself, or a directory above it */
  path: string
}

export interface ConceptMap {
  tree: ConceptTree
  page(id: string): ConceptPage | undefined
  /** The pages whose claims cover a file */
  claimants(file: string): Claimant[]
  /** The page owning a file: the deepest claimant; then the narrower claim; then by id. Undefined when none claims it */
  pageOfFile(file: string): string | undefined
  /** The page a symbol belongs to: the innermost symbol a page names that holds it, else its file's page */
  pageOf(node: Placed): string | undefined
  /** Per page, the symbols its backticked names resolve to and it keeps (a symbol two pages name goes to the deeper) */
  symbols: ReadonlyMap<string, GraphNode[]>
  /** Per page, the backticked names that resolve to no symbol */
  unresolved: ReadonlyMap<string, string[]>
}

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const within = (file: string, path: string) => file === path || file.startsWith(`${path}/`)

/** Deepest page first, then the narrower claim, then by id */
function byOwnership(depthOf: (id: string) => number) {
  return (a: Claimant, b: Claimant) =>
    depthOf(b.page) - depthOf(a.page) || b.path.length - a.path.length || byCodeUnit(a.page, b.page)
}

/**
 * The symbols a backticked name names: by name, or by qualified-name suffix for `Outer::name`; those in the paths
 * the claim's bullet links, else the one symbol in the index with that name.
 */
function resolveClaim(claim: SymbolClaim, byName: ReadonlyMap<string, GraphNode[]>): GraphNode[] {
  const last = claim.name.slice(claim.name.lastIndexOf(':') + 1)
  const candidates = (byName.get(last) ?? []).filter(
    (n) => !claim.name.includes('::') || n.qualifiedName === claim.name || n.qualifiedName.endsWith(`::${claim.name}`)
  )
  const inScope = candidates.filter((n) => claim.scope.some((s) => within(n.filePath, s)))
  if (inScope.length > 0) return inScope
  return candidates.length === 1 ? candidates : []
}

export function createConceptMap(tree: ConceptTree, nodes: readonly GraphNode[]): ConceptMap {
  const pages = new Map(tree.pages.map((p) => [p.id, p]))
  const depthOf = (id: string) => pages.get(id)?.depth ?? 0
  const ownership = byOwnership(depthOf)

  const claims = new Map<string, Array<{ page: string; dir: boolean }>>()
  for (const p of tree.pages) {
    for (const c of p.paths) {
      if (c.kind === 'missing') continue
      const list = claims.get(c.path) ?? []
      list.push({ page: p.id, dir: c.kind === 'dir' })
      claims.set(c.path, list)
    }
  }
  const claimantsOf = new Map<string, Claimant[]>()
  const claimants = (file: string): Claimant[] => {
    let found = claimantsOf.get(file)
    if (found) return found
    const byPage = new Map<string, Claimant>()
    // The file itself, then each directory above it: the first claim a page makes is its narrowest
    for (let path = file, isFile = true; path !== ''; path = dirname(path), isFile = false) {
      for (const c of claims.get(path) ?? []) {
        if (c.dir !== isFile && !byPage.has(c.page)) byPage.set(c.page, { page: c.page, path })
      }
    }
    found = [...byPage.values()].sort(ownership)
    claimantsOf.set(file, found)
    return found
  }

  const byName = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (!isSymbol(n)) continue
    const list = byName.get(n.name)
    if (list) list.push(n)
    else byName.set(n.name, [n])
  }
  // Each claimed symbol to one page: the deepest naming it, then by id
  const claimedBy = new Map<GraphNode, string>()
  const claimOrder: Array<{ page: string; node: GraphNode }> = []
  const unresolved = new Map<string, string[]>()
  for (const p of tree.pages) {
    const missing: string[] = []
    for (const claim of p.symbols) {
      const found = resolveClaim(claim, byName)
      if (found.length === 0 && !missing.includes(claim.name)) missing.push(claim.name)
      for (const n of found) {
        claimOrder.push({ page: p.id, node: n })
        const held = claimedBy.get(n)
        if (held === undefined || depthOf(p.id) > depthOf(held) || (depthOf(p.id) === depthOf(held) && p.id < held)) {
          claimedBy.set(n, p.id)
        }
      }
    }
    unresolved.set(p.id, missing)
  }
  const symbols = new Map<string, GraphNode[]>(tree.pages.map((p) => [p.id, []]))
  for (const { page, node } of claimOrder) {
    const list = symbols.get(page)!
    if (claimedBy.get(node) === page && !list.includes(node)) list.push(node)
  }
  const spans = new Map<string, Array<{ node: GraphNode; page: string }>>()
  for (const [node, page] of claimedBy) {
    const list = spans.get(node.filePath) ?? []
    list.push({ node, page })
    spans.set(node.filePath, list)
  }

  const pageOfFile = (file: string) => claimants(file)[0]?.page
  return {
    tree,
    page: (id) => pages.get(id),
    claimants,
    pageOfFile,
    pageOf: (n) => {
      let best: { node: GraphNode; page: string } | undefined
      for (const s of spans.get(n.filePath) ?? []) {
        if (s.node.startLine > n.startLine || s.node.endLine < n.endLine) continue
        const size = s.node.endLine - s.node.startLine
        const bestSize = best ? best.node.endLine - best.node.startLine : Infinity
        if (size < bestSize || (size === bestSize && depthOf(s.page) > depthOf(best!.page))) best = s
      }
      return best?.page ?? pageOfFile(n.filePath)
    },
    symbols,
    unresolved
  }
}

/** The deepest directory holding every file ('' for the repo root) */
function commonDir(files: readonly string[]): string {
  let common = dirname(files[0]).split('/')
  for (const f of files.slice(1)) {
    const segs = dirname(f).split('/')
    let i = 0
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++
    common = common.slice(0, i)
  }
  return common.join('/')
}

export interface ConceptChecks {
  coverage: ConceptCoverage
  stale: StaleClaim[]
  shared: SharedClaim[]
}

/**
 * The scripted checks: coverage (indexed files no page claims, by directory), stale claims (linked paths that do not
 * exist) and shared claims (files claimed by unrelated pages: indexed files and every linked file).
 */
export function conceptChecks(map: ConceptMap, nodes: readonly GraphNode[]): ConceptChecks {
  const files = [...new Set(nodes.filter((n) => n.kind === 'file').map((n) => n.filePath))]
  const uncovered = new Map<string, number>()
  for (const f of files) {
    if (map.pageOfFile(f) !== undefined) continue
    const dir = dirname(f) || '.'
    uncovered.set(dir, (uncovered.get(dir) ?? 0) + 1)
  }
  const coverage: ConceptCoverage = {
    files: files.length,
    covered: files.length - [...uncovered.values()].reduce((a, b) => a + b, 0),
    uncovered: [...uncovered]
      .map(([dir, n]) => ({ dir, files: n }))
      .sort((a, b) => b.files - a.files || byCodeUnit(a.dir, b.dir))
  }

  const stale = map.tree.pages.flatMap((p) =>
    p.paths.filter((c) => c.kind === 'missing').map((c) => ({ page: p.id, path: c.path }))
  )

  const linked = map.tree.pages.flatMap((p) => p.paths.filter((c) => c.kind === 'file').map((c) => c.path))
  const depthOf = (id: string) => map.page(id)?.depth ?? 0
  const groups = new Map<string, { pages: string[]; files: string[] }>()
  for (const f of new Set([...files, ...linked])) {
    const pages = map.claimants(f).map((c) => c.page)
    const leaves = pages.filter((p) => !pages.some((o) => isAncestor(p, o)))
    if (leaves.length < 2) continue
    leaves.sort((a, b) => depthOf(b) - depthOf(a) || byCodeUnit(a, b))
    const key = leaves.join('\u0000')
    const group = groups.get(key) ?? { pages: leaves, files: [] }
    group.files.push(f)
    groups.set(key, group)
  }
  const shared = [...groups.values()]
    .map((g) => ({
      path: g.files.length === 1 ? g.files[0] : commonDir(g.files),
      pages: g.pages,
      files: g.files.length
    }))
    .sort((a, b) => b.files - a.files || byCodeUnit(a.path, b.path))

  return { coverage, stale, shared }
}

/** Trusted code edges (`hygiene`) lifted to the pages of their ends; edges inside one page and from or to unmapped code drop */
export function conceptDependencies(
  map: ConceptMap,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  hygiene: EdgeHygiene
): ConceptDependency[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const counts = new Map<string, ConceptDependency>()
  for (const e of hygiene.trusted(edges)) {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    const from = s && map.pageOf(s)
    const to = t && map.pageOf(t)
    if (from === undefined || to === undefined || from === to) continue
    const key = `${from}\u0000${to}`
    const held = counts.get(key)
    if (held) held.edges++
    else counts.set(key, { from, to, edges: 1 })
  }
  return [...counts.values()].sort((a, b) => b.edges - a.edges || byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to))
}

/** The tree with each page's counts, the checks and the dependencies: what the Code view shows */
export function conceptMapReport(
  map: ConceptMap,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  hygiene: EdgeHygiene
): Omit<ConceptMapReport, 'path' | 'sha'> {
  const owned = new Map<string, number>()
  for (const n of nodes) {
    if (n.kind !== 'file') continue
    const page = map.pageOfFile(n.filePath)
    if (page !== undefined) owned.set(page, (owned.get(page) ?? 0) + 1)
  }
  const pages: ConceptNode[] = map.tree.pages.map((p) => ({
    id: p.id,
    parent: p.parent,
    children: p.children,
    depth: p.depth,
    file: p.file,
    title: p.title,
    model: p.model,
    why: p.why,
    files: owned.get(p.id) ?? 0,
    symbols: map.symbols.get(p.id)?.length ?? 0,
    unresolved: map.unresolved.get(p.id) ?? [],
    flows: p.flows.length
  }))
  return {
    dir: map.tree.dir,
    pages,
    ...conceptChecks(map, nodes),
    dependencies: conceptDependencies(map, nodes, edges, hygiene)
  }
}
