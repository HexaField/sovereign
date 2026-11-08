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
  /** The concept page the symbol belongs to (`ConceptTouch.id`), when the repo has a concept tree on that side */
  concept?: string
}

/**
 * One module and how much of it a change touches. In a repo with a concept tree a module is the concept page the
 * code → concept map gives a symbol; code no page claims, and a repo without a tree, fall back to directories: a
 * package and the first directory below its source root (`rust-executor/src/perspectives`).
 */
export interface ModuleTouch {
  /** Module id: the concept page file, or the directory, repo-relative */
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
  /** The merge base the change is measured from: a full commit sha */
  base: string
  /** The head commit: a full commit sha */
  head: string
  /** Most touched first */
  modules: ModuleTouch[]
  /** Each list by file, then line */
  symbols: { added: SymbolRef[]; removed: SymbolRef[]; modified: SymbolRef[] }
  /**
   * How far the change spreads: the diameter of the changed symbols, the most hops between two of them on the
   * structure graph (see `changeReach` in graphcoder-core). 0 for one symbol or none.
   */
  reach: number
  /** Separate pieces the changed symbols fall into on that graph; `reach` is the widest piece's diameter */
  parts: number
  /** Nearest first */
  tests: TestRef[]
  violations: Violation[]
  /** What the change does to the concept tree; absent when neither side has one */
  concepts?: ChangeConcepts
}

/** The function Sovereign hands the work graph: the structure of a change in one checkout */
export type StructureOf = (repoPath: string, base: string, head: string) => Promise<ChangeStructure>

// ── Concepts ─────────────────────────────────────────────────────────────────
// A concept tree is a folder of Markdown pages committed with the code
// (ad4m's `mental-models/`): one page per concept, `folder/README.md` a node,
// `file.md` a leaf. A page's "Where in the code" links claim code; the deepest
// page claiming a file owns it, and a symbol a page names belongs to that page.

/** A page's text: what the reader skims */
export interface ConceptText {
  title: string
  /** The first paragraph: what the thing is and does */
  model: string
  why: string
}

/** A concept page a change touches, or an ancestor of one (then with no `page` change and no symbols) */
export interface ConceptTouch extends ConceptText {
  /** Path under the tree folder without `.md` or `/README.md`; `''` for the root */
  id: string
  parent: string | null
  depth: number
  /** Repo-relative page file: head's, base's for a removed page */
  file: string
  /** The change adds, changes or removes the page itself (a model shift) */
  page?: 'added' | 'changed' | 'removed'
  /** The page's text on base, when the change edits the title, model or Why */
  before?: ConceptText
  /** Changed symbols the code → concept map places on this page (head's map; base's for removed symbols) */
  symbols: { added: number; removed: number; modified: number }
  /** Code files of those symbols */
  files: string[]
  /** `TestRef.id`s of the tests that reach this page's changed symbols */
  tests: string[]
  /** `stale-page`: code changed under a page that did not change. `docs-only`: the page changed, no code under it */
  signal?: 'stale-page' | 'docs-only'
}

export interface ChangeConcepts {
  /** Repo-relative tree folder */
  dir: string
  /** One line: the concepts the change shifts, then those it touches in code only; '' when it touches none */
  summary: string
  /** Touched pages and their ancestors, parents first */
  pages: ConceptTouch[]
}

/** One page of a concept tree, with what the code → concept map gives it */
export interface ConceptNode extends ConceptText {
  id: string
  parent: string | null
  children: string[]
  depth: number
  file: string
  /** Indexed files this page owns */
  files: number
  /** Backticked names in "Where in the code" that resolve to a symbol the page owns */
  symbols: number
  /** Backticked names that resolve to no symbol */
  unresolved: string[]
  /** Numbered flows in "How it works" */
  flows: number
}

/** A page links a path that does not exist */
export interface StaleClaim {
  page: string
  path: string
}

/**
 * Files that two or more unrelated pages claim (none an ancestor of another; D7: the deepest owns each file). One
 * finding per set of pages.
 */
export interface SharedClaim {
  /** The file, or the deepest directory holding all the files */
  path: string
  /** The claiming pages (ancestors of another claimant left out), deepest first */
  pages: string[]
  files: number
}

/** Trusted code edges (edge hygiene) from one page's code to another's */
export interface ConceptDependency {
  from: string
  to: string
  edges: number
}

export interface ConceptCoverage {
  /** Indexed files */
  files: number
  /** Of those, files a page owns */
  covered: number
  /** The rest, by directory, most first */
  uncovered: Array<{ dir: string; files: number }>
}

/** A repo's concept tree at one commit, mapped onto its code, with the scripted checks */
export interface ConceptMapReport {
  /** Checkout */
  path: string
  /** Commit read */
  sha: string
  /** Repo-relative tree folder */
  dir: string
  /** Parents first; empty when the commit has no tree */
  pages: ConceptNode[]
  coverage: ConceptCoverage
  stale: StaleClaim[]
  shared: SharedClaim[]
  /** Most edges first */
  dependencies: ConceptDependency[]
}
