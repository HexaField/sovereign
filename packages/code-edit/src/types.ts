import type { CodeTraits } from './text.js'

/** One step of an edit. A call applies its ops in order; any failure writes nothing. */
export type EditOp =
  | { op: 'replace'; symbol: string; code: string }
  | { op: 'replace_in'; symbol?: string; find: string; to?: string; code: string }
  | { op: 'insert'; code: string; after?: string; before?: string }
  | { op: 'remove'; symbol: string }
  | { op: 'create'; code: string }

export interface EditArgs {
  /** Absolute path of the file to edit or create. */
  file: string
  ops: EditOp[]
  /** Compute and report the change without writing it. */
  dryRun?: boolean
}

/**
 * One declaration in a file. Offsets index the LF-normalised text; they
 * follow the region rules the ops rely on:
 *
 *   [overloadStart ── overload signatures] ── triviaStart ── attached comments ──
 *   decoratorStart ── decorators ── headStart ── [exportPrefix] declaration ──
 *   [value] ── end
 */
export interface Declaration {
  name: string
  /** Containers joined with `::`, e.g. `createChatModule::handleSend`. */
  qualifiedName: string
  kind: string
  signature?: string
  /** Start of the TS overload signatures above, with their comments. remove and insert take them along; replace keeps them. */
  overloadStart?: number
  /** Start of the comments and decorators attached above; equals headStart when there are none. */
  triviaStart: number
  /** Earliest decorator or attribute, when the declaration has one. */
  decoratorStart?: number
  /** Where the declaration proper begins, after its decorators: `export`, `pub`, a keyword, a name. */
  headStart: number
  /** Visibility that replacement code keeps when it omits it: 'export ', 'export default ', 'pub '. */
  exportPrefix?: string
  /** The value, when the symbol is a function or class assigned to a variable. */
  value?: { start: number; end: number }
  /** Where the declaration's code ends; a comment after it on the same line stays outside. */
  end: number
  /** 1-based lines: the first line (overloads or trivia), the head, and the last line. */
  startLine: number
  line: number
  endLine: number
}

export interface SyntaxProblem {
  line: number
  /** 0-based. */
  column: number
  message: string
  /** Identifies the problem without its position, so edits elsewhere in the file leave it unchanged. */
  key: string
}

export interface LanguageTraits extends CodeTraits {
  /** Matches a declaration head that states its own visibility, e.g. /^export\b/. */
  exported?: RegExp
  /** Matches a head that restates a whole variable statement (`const x = …`), not just its value. */
  statement?: RegExp
  /** Matches a head that declares something; visibility is kept only in front of one. */
  declaration?: RegExp
}

export interface Analysis {
  /** False when no grammar covers this file type, so nothing checks its syntax. */
  checked: boolean
  /**
   * Every problem the grammar reports, in file order. Grammars have gaps, so
   * valid code can appear here; edits are judged by the problems they add.
   */
  syntaxErrors: SyntaxProblem[]
  /** A stricter checker's verdict (CPython for Python): its first problem, null when clean, absent when none ran. */
  strictError?: SyntaxProblem | null
  declarations: Declaration[]
  traits: LanguageTraits
}

/** Parses a file's text into declarations and a syntax verdict. */
export interface Analyzer {
  /** Ready the analyzer for `path`'s language (load its grammar). Call before `analyze`. */
  prepare?(path: string): Promise<void>
  analyze(path: string, text: string): Analysis
}

export class EditError extends Error {
  override name = 'EditError'
}
