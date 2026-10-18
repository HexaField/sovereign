// The contract between Graphcoder and the rest of Sovereign: the only thing
// another Sovereign package may import from Graphcoder, and only as types
// (`import type … from '@sovereign/graphcoder-core/contract'`). The work graph
// receives a `StructureOf` at bootstrap and renders what it returns on a PR
// card; it never imports Graphcoder code.

/** A symbol a change touches, named by semantic id */
export interface SymbolRef {
  /** Semantic id */
  id: string
  kind: string
  name: string
  qualifiedName: string
  /** Repo-relative file, in the head snapshot (the base snapshot for a removed symbol) */
  filePath: string
}

/** One module (a module annotation in `.graphcoder/`) and how much of it a change touches */
export interface ModuleTouch {
  /** Annotation slug */
  module: string
  label: string
  added: number
  removed: number
  modified: number
}

/** A test that statically reaches a changed symbol */
export interface TestRef {
  /** `<file>::<full test name>`, or the file path when the file counts as one test */
  id: string
  file: string
  /** Hops from the test into non-test code; 1 = the test calls the symbol directly */
  depth: number
}

/** A dependency a change adds that an architectural rule forbids */
export interface Violation {
  ruleId: string
  /** Annotation slug the rule sits on, `*` for a map-wide rule */
  annotation: string
  /** The decision in plain words */
  rationale: string
  /** Only accepted rules fail a check; proposed ones are advice */
  status: 'proposed' | 'accepted'
  /** Qualified names of the edge's ends */
  source: string
  target: string
  kind: string
  /** Repo-relative file and line of the edge */
  file: string
  line: number | null
}

/** What a change (head against its merge base with base) does to the structure of a repository */
export interface ChangeStructure {
  base: string
  head: string
  modules: ModuleTouch[]
  symbols: { added: SymbolRef[]; removed: SymbolRef[]; modified: SymbolRef[] }
  /** Symbols outside the change that reach a changed one */
  reach: number
  tests: TestRef[]
  violations: Violation[]
}

/** The function Sovereign hands the work graph: the structure of a change in one checkout */
export type StructureOf = (repoPath: string, base: string, head: string) => Promise<ChangeStructure>
