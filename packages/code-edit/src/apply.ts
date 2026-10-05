// Applies edit ops to a file's text. Pure: the analyzer supplies declarations
// and syntax verdicts; nothing here touches the filesystem.
//
// Every op resolves its symbol against the text as it stands after the ops
// before it, and the text is re-analysed after each op. An op that breaks a
// file which parsed before fails the whole call.

import { resolveSymbol } from './resolve.js'
import {
  AnchorError,
  declarationHead,
  endsLine,
  endsWithComment,
  findAnchor,
  indentAt,
  indentBlock,
  leadingElement,
  leadingParts,
  lineEnd,
  lineOf,
  lineStart,
  reindent,
  startsLine,
  trailingCommentEnd
} from './text.js'
import { EditError, type Analysis, type Analyzer, type Declaration, type EditOp, type SyntaxProblem } from './types.js'

export interface SignatureChange {
  qualifiedName: string
  before?: string
  after?: string
  /** Set when the op renamed the declaration. */
  renamedTo?: string
}

export interface EditOutcome {
  text: string
  /** One line per op, then warnings. */
  notes: string[]
  signatureChanges: SignatureChange[]
  analysis: Analysis
  /** False when no grammar covers the file, or it had a syntax error before the edit. */
  syntaxChecked: boolean
}

export interface ApplyOptions {
  /** How messages name the file. */
  label: string
  /** False when the file does not exist yet; then the first op must be `create`. */
  exists: boolean
}

interface Step {
  text: string
  note: (after: string) => string
  /** Checks the re-analysed text; may throw or return a note. */
  verify?: (next: Analysis) => string | undefined
  change?: (next: Analysis) => SignatureChange | undefined
}

const SHOW_LINES = 60

export function applyOps(
  path: string,
  text: string,
  ops: EditOp[],
  analyzer: Analyzer,
  opts: ApplyOptions
): EditOutcome {
  if (ops.length === 0) throw new EditError('No ops given.')
  if (ops.slice(1).some((op) => op.op === 'create')) throw new EditError('create must be the first op.')
  const creating = ops[0].op === 'create'
  if (creating && opts.exists) throw new EditError(`${opts.label} already exists; create only makes new files.`)
  if (!creating && !opts.exists) throw new EditError(`${opts.label} does not exist. Use a create op to make it.`)

  let cur = creating ? reindent((ops[0] as { code: string }).code, '') + '\n' : text
  let analysis = analyzer.analyze(path, cur)
  const notes: string[] = []
  const warnings: string[] = []
  const changes: SignatureChange[] = []
  if (creating) {
    const problem = analysis.strictError ?? analysis.syntaxErrors[0]
    if (problem) throw new EditError(`create: ${syntaxMessage(problem, cur)}`)
    notes.push(`create · ${lineOf(cur, cur.length - 1)} lines`)
  }
  if (!analysis.checked) warnings.push('No grammar for this file type: syntax not checked.')
  else if (analysis.strictError) {
    const e = analysis.strictError
    warnings.push(
      `The file already fails its strict syntax check (${e.message}, line ${e.line}:${e.column + 1}); only parse errors are checked.`
    )
  }

  ops.slice(creating ? 1 : 0).forEach((op, i) => {
    const tag = ops.length > 1 ? `op ${i + (creating ? 2 : 1)} (${op.op})` : op.op
    const tagged = <T>(run: () => T): T => {
      try {
        return run()
      } catch (err) {
        throw err instanceof EditError ? new EditError(`${tag}: ${err.message}`) : err
      }
    }
    const step = tagged(() => applyOne(op, cur, analysis, opts.label))
    const next = analyzer.analyze(path, step.text)
    const added = addedProblem(analysis, next)
    if (added) throw new EditError(`${tag} breaks the syntax: ${syntaxMessage(added, step.text)}`)
    const warning = tagged(() => step.verify?.(next))
    if (warning) warnings.push(warning)
    const change = step.change?.(next)
    if (change) changes.push(change)
    notes.push(step.note(step.text))
    cur = step.text
    analysis = next
  })

  return {
    text: cur,
    notes: [...notes, ...warnings],
    signatureChanges: changes,
    analysis,
    syntaxChecked: analysis.checked
  }
}

function applyOne(op: EditOp, text: string, analysis: Analysis, label: string): Step {
  switch (op.op) {
    case 'replace':
      return replace(op.symbol, op.code, text, analysis, label)
    case 'replace_in':
      return replaceIn(op, text, analysis, label)
    case 'replace_all':
      return replaceAll(op, text, analysis, label)
    case 'insert':
      return insert(op, text, analysis, label)
    case 'remove':
      return remove(op.symbol, text, analysis, label)
    case 'create':
      throw new EditError('create must be the first op.')
    default:
      throw new EditError(`Unknown op '${(op as { op: string }).op}'.`)
  }
}

// ── replace ───────────────────────────────────────────────────────────────────

function replace(symbol: string, code: string, text: string, analysis: Analysis, label: string): Step {
  const d = lookup(analysis, symbol, label)
  const { traits } = analysis
  const lead = leadingElement(code, traits)
  const leading = leadingParts(code, traits)
  const head = code.slice(leading.head).trimStart()

  // How far back the code reaches decides what it replaces: comments first,
  // then decorators, then the declaration; for a function or class held in a
  // variable, code that does not restate the statement replaces only the value.
  // A comment after the declaration on its last line stays unless the code ends with one.
  let start = d.headStart
  let end = d.end
  const valueOnly = lead === 'code' && d.value !== undefined && !traits.statement?.test(head)
  if (lead === 'comment') start = d.triviaStart
  else if (lead === 'decorator') start = d.decoratorStart ?? d.headStart
  else if (valueOnly) ({ start, end } = d.value!)
  if (endsWithComment(code, traits)) end = trailingCommentEnd(text, end, traits)

  // Decorators and visibility the code omits stay, in front of its declaration.
  let body = reindent(code, indentAt(text, start))
  const kept: string[] = []
  if (lead === 'comment' && d.decoratorStart !== undefined && !leading.decorated) {
    const at = declarationHead(body, traits)
    body = body.slice(0, at) + text.slice(d.decoratorStart, d.headStart) + body.slice(at)
    kept.push('kept the decorators (the code omitted them; use replace_in to drop them)')
  }
  if (!valueOnly && d.exportPrefix && !traits.exported?.test(head) && traits.declaration?.test(head)) {
    const at = declarationHead(body, traits)
    body = body.slice(0, at) + d.exportPrefix + body.slice(at)
    kept.push(`kept '${d.exportPrefix.trim()}' (the code omitted it; use replace_in to drop it)`)
  }
  const next = text.slice(0, start) + body + text.slice(end)
  const lo = start
  const hi = start + body.length

  const occupant = (after: Analysis) => {
    const inside = after.declarations.filter(
      (x) => within(x.headStart, lo, hi) || (x.value && within(x.value.start, lo, hi))
    )
    return (
      inside.find((x) => x.qualifiedName === d.qualifiedName) ?? inside.sort((a, b) => a.headStart - b.headStart)[0]
    )
  }
  return {
    text: next,
    note: (after) =>
      `replace ${d.qualifiedName}${valueOnly ? ' (value)' : ''} · lines ${d.startLine}–${d.endLine} → ${lineOf(after, lo)}–${lineOf(after, hi)}`,
    verify: (after) => {
      const o = occupant(after)
      if (!o) {
        throw new EditError(
          `the code holds no declaration where '${d.qualifiedName}' was. replace swaps whole declarations; use replace_in to change part of one.`
        )
      }
      const notes = [
        ...kept,
        ...(o.qualifiedName !== d.qualifiedName
          ? [`renamed ${d.qualifiedName} → ${o.qualifiedName}; references are not updated`]
          : [])
      ]
      return notes.length ? notes.join('; ') : undefined
    },
    change: (after) => signatureChange(d, occupant(after))
  }
}

// ── replace_in ────────────────────────────────────────────────────────────────

function replaceIn(op: Extract<EditOp, { op: 'replace_in' }>, text: string, analysis: Analysis, label: string): Step {
  const d = op.symbol ? lookup(analysis, op.symbol, label) : undefined
  // Search from the start of the declaration's line, so indentation-insensitive
  // matching sees the first line's real indent, through a comment after its end.
  const top = d ? topOf(d) : 0
  const hayStart = d && startsLine(text, top) ? lineStart(text, top) : top
  const hay = text.slice(hayStart, d ? trailingCommentEnd(text, d.end, analysis.traits) : text.length)
  const where = d ? `'${d.qualifiedName}'` : label

  const first = anchor(hay, op.find, 'find', where, d, text, hayStart)
  let endRel = first.end
  let exact = first.exact
  if (op.to !== undefined) {
    const second = anchor(hay.slice(first.end), op.to, 'to', `${where} after find`, d, text, hayStart + first.end)
    endRel = first.end + second.end
    exact = exact && second.exact
  }
  const start = hayStart + first.start
  const end = hayStart + endRel
  const body = exact ? op.code.replace(/\r\n/g, '\n') : reindent(op.code, indentAt(text, start))
  const next = text.slice(0, start) + body + text.slice(end)
  const oldLines = text.slice(start, end).split('\n').length
  const newLines = body.split('\n').length

  // The declaration now around the edit: the same name, or a same-kind sibling (a rename).
  const parent = d ? containerOf(d.qualifiedName) : ''
  const owner = (after: Analysis) => {
    if (!d) return undefined
    const around = after.declarations.filter(
      (x) => topOf(x) <= start && start <= trailingCommentEnd(next, x.end, after.traits)
    )
    return (
      around.find((x) => x.qualifiedName === d.qualifiedName) ??
      around.find((x) => x.kind === d.kind && containerOf(x.qualifiedName) === parent)
    )
  }
  return {
    text: next,
    note: (after) =>
      `replace_in ${d ? d.qualifiedName : 'file'} · line ${lineOf(after, start)}: ${oldLines} → ${newLines} line${newLines === 1 ? '' : 's'}${exact ? '' : ' (matched ignoring indentation)'}`,
    verify: (after) => {
      if (!d) return undefined
      const o = owner(after)
      if (!o) {
        throw new EditError(
          `the change leaves no declaration '${d.qualifiedName}' around the edit. Use replace for whole declarations, or remove.`
        )
      }
      return o.qualifiedName !== d.qualifiedName
        ? `renamed ${d.qualifiedName} → ${o.qualifiedName}; references are not updated`
        : undefined
    },
    change: (after) => (d ? signatureChange(d, owner(after)) : undefined)
  }
}

// ── replace_all ───────────────────────────────────────────────────────────────

/**
 * Every match of find, in the symbol or the whole file. count states how many
 * matches the caller expects; any other number fails the call, so a find that
 * matches nothing (or too much) can never pass silently.
 */
function replaceAll(op: Extract<EditOp, { op: 'replace_all' }>, text: string, analysis: Analysis, label: string): Step {
  if (!op.find) throw new EditError('find is empty.')
  const d = op.symbol ? lookup(analysis, op.symbol, label) : undefined
  const top = d ? topOf(d) : 0
  const from = d && startsLine(text, top) ? lineStart(text, top) : top
  const to = d ? trailingCommentEnd(text, d.end, analysis.traits) : text.length
  const where = d ? `'${d.qualifiedName}'` : label

  let pattern: RegExp
  try {
    pattern = op.regex
      ? new RegExp(op.find, 'gm')
      : new RegExp(op.find.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  } catch (err) {
    throw new EditError(`find is not a valid regular expression: ${(err as Error).message}`)
  }
  const hay = text.slice(from, to)
  const hits = [...hay.matchAll(pattern)]
  if (hits.some((m) => m[0] === ''))
    throw new EditError('find matches empty text; every match must cover at least one character.')
  const lines = [...new Set(hits.map((m) => lineOf(text, from + m.index)))]
  if (hits.length !== op.count) {
    throw new EditError(
      `find matches ${hits.length} place${hits.length === 1 ? '' : 's'} in ${where}${lines.length ? ` (line${lines.length === 1 ? '' : 's'} ${lineList(lines)})` : ''}, not ${op.count}. Check the matches, then set count to the number you mean to change.`
    )
  }
  const code = op.code.replace(/\r\n/g, '\n')
  // A literal find inserts code as written; a regex find expands $1, $<name> and $&.
  const body = op.regex ? hay.replace(pattern, code) : hay.replace(pattern, () => code)
  return {
    text: text.slice(0, from) + body + text.slice(to),
    note: () =>
      `replace_all ${d ? d.qualifiedName : 'file'} · ${hits.length} replacement${hits.length === 1 ? '' : 's'} on line${lines.length === 1 ? '' : 's'} ${lineList(lines)}`
  }
}

/** 1-based line numbers, the first 20 then a count. */
function lineList(lines: number[]): string {
  return lines.length > 20 ? `${lines.slice(0, 20).join(', ')}, … ${lines.length - 20} more` : lines.join(', ')
}

/** findAnchor in `hay`, which starts at `offset` in `text`, with errors that name lines and show the symbol. */
function anchor(
  hay: string,
  needle: string,
  field: 'find' | 'to',
  where: string,
  d: Declaration | undefined,
  text: string,
  offset: number
) {
  try {
    return findAnchor(hay, needle)
  } catch (err) {
    if (!(err instanceof AnchorError)) throw err
    if (err.reason === 'many') {
      const lines = err.hits.map((h) => lineOf(text, offset + h)).join(', ')
      throw new EditError(
        `${field} matches ${err.hits.length} places in ${where} (lines ${lines}). Add surrounding text to make it unique.`
      )
    }
    if (!d) throw new EditError(`${field} matches nothing in ${where}.`)
    throw new EditError(`${field} matches nothing in ${where}. Its current text:\n${numbered(text, topOf(d), d.end)}`)
  }
}

// ── insert ────────────────────────────────────────────────────────────────────

function insert(op: Extract<EditOp, { op: 'insert' }>, text: string, analysis: Analysis, label: string): Step {
  if (op.after !== undefined && op.before !== undefined) throw new EditError('give after or before, not both.')
  const anchorName = op.after ?? op.before
  if (anchorName === undefined) {
    const body = reindent(op.code, '')
    const trimmed = text.replace(/\n+$/, '')
    const at = trimmed.length ? trimmed.length + 2 : 0
    const next = (trimmed.length ? trimmed + '\n\n' : '') + body + (text.endsWith('\n') || !text ? '\n' : '')
    return {
      text: next,
      note: (after) => `insert at end of file · lines ${lineOf(after, at)}–${lineOf(after, at + body.length)}`
    }
  }

  const d = lookup(analysis, anchorName, label)
  const top = topOf(d)
  if (!startsLine(text, top)) {
    throw new EditError(
      `'${d.qualifiedName}' shares line ${d.line} with other code; insert needs a symbol on its own lines. Use replace_in instead.`
    )
  }
  const block = indentBlock(op.code, indentAt(text, top))
  let at: number
  let next: string
  if (op.after !== undefined) {
    if (!endsLine(text, d.end, analysis.traits)) {
      throw new EditError(
        `'${d.qualifiedName}' ends mid-line (line ${d.endLine}); insert after it is ambiguous. Use replace_in instead.`
      )
    }
    const eol = lineEnd(text, d.end)
    const following = eol < text.length ? text.slice(eol + 1, lineEnd(text, eol + 1)) : ''
    const gap = following.trim() && !/^\s*[}\])]/.test(following) ? '\n' : ''
    at = eol + 2
    next = text.slice(0, eol) + '\n\n' + block + gap + text.slice(eol)
  } else {
    const sol = lineStart(text, top)
    const preceding = sol > 0 ? text.slice(lineStart(text, sol - 1), sol - 1) : ''
    const gap = preceding.trim() && !/[{([:]\s*$/.test(preceding) ? '\n' : ''
    at = sol + gap.length
    next = text.slice(0, sol) + gap + block + '\n\n' + text.slice(sol)
  }
  return {
    text: next,
    note: (after) =>
      `insert ${op.after !== undefined ? 'after' : 'before'} ${d.qualifiedName} · lines ${lineOf(after, at)}–${lineOf(after, at + block.length)}`
  }
}

// ── remove ────────────────────────────────────────────────────────────────────

function remove(symbol: string, text: string, analysis: Analysis, label: string): Step {
  const d = lookup(analysis, symbol, label)
  const top = topOf(d)
  let next: string
  if (startsLine(text, top) && endsLine(text, d.end, analysis.traits)) {
    const eol = lineEnd(text, d.end)
    next = removeLines(text, lineStart(text, top), eol < text.length ? eol + 1 : eol)
  } else {
    // Mid-line (an enum member, a type literal member): take one list separator with it.
    let from = top
    let to = d.end
    const after = /^[ \t]*[,;][ \t]*/.exec(text.slice(to))
    if (after) to += after[0].length
    else {
      const before = /[ \t]*,[ \t]*$/.exec(text.slice(lineStart(text, from), from))
      if (before) from -= before[0].length
    }
    next = text.slice(0, from) + text.slice(to)
  }
  return { text: next, note: () => `remove ${d.qualifiedName} · lines ${d.startLine}–${d.endLine}` }
}

/**
 * Delete the whole lines [from, to) and the blank lines around them, then put
 * one gap back: the wider of the two, or the narrower beside a bracket that
 * opens or closes a block, or at either end of the file.
 */
function removeLines(text: string, from: number, to: number): string {
  let start = from
  let before = 0
  while (start > 0 && !text.slice(lineStart(text, start - 1), start - 1).trim()) {
    start = lineStart(text, start - 1)
    before++
  }
  let end = to
  let after = 0
  while (end < text.length && !text.slice(end, lineEnd(text, end)).trim()) {
    end = Math.min(text.length, lineEnd(text, end) + 1)
    after++
  }
  const prev = start > 0 ? text.slice(lineStart(text, start - 1), start - 1) : ''
  const edge =
    start === 0 ||
    end >= text.length ||
    /[{([:]\s*$/.test(prev) ||
    /^\s*[}\])]/.test(text.slice(end, lineEnd(text, end)))
  return text.slice(0, start) + '\n'.repeat(edge ? Math.min(before, after) : Math.max(before, after)) + text.slice(end)
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** A file that does not parse yields no symbols; say why instead of listing none. */
function lookup(analysis: Analysis, symbol: string, label: string): Declaration {
  const e = analysis.strictError ?? analysis.syntaxErrors[0]
  if (e && analysis.declarations.length === 0) {
    throw new EditError(
      `${label} has a syntax error at line ${e.line}:${e.column + 1}, so no symbol resolves. Fix it first: replace_in without a symbol still works.`
    )
  }
  return resolveSymbol(analysis.declarations, symbol, label)
}

/** Where everything that belongs to a declaration begins: its overload signatures, else its comments and decorators. */
function topOf(d: Declaration): number {
  return d.overloadStart ?? d.triviaStart
}

function containerOf(qualifiedName: string): string {
  return qualifiedName.split('::').slice(0, -1).join('::')
}

function within(offset: number, lo: number, hi: number): boolean {
  return offset >= lo && offset < hi
}

function signatureChange(before: Declaration, after: Declaration | undefined): SignatureChange | undefined {
  if (!after) return undefined
  const renamed = after.qualifiedName !== before.qualifiedName
  if (!renamed && (before.signature ?? '') === (after.signature ?? '')) return undefined
  return {
    qualifiedName: before.qualifiedName,
    before: before.signature,
    after: after.signature,
    ...(renamed ? { renamedTo: after.qualifiedName } : {})
  }
}

/**
 * The first problem `after` has that `before` did not. Parse problems count by
 * key, so one that an edit only moves is not new; a strict verdict counts only
 * when the file passed the strict check before.
 */
function addedProblem(before: Analysis, after: Analysis): SyntaxProblem | undefined {
  if (before.strictError === null && after.strictError) return after.strictError
  const seen = new Map<string, number>()
  for (const p of before.syntaxErrors) seen.set(p.key, (seen.get(p.key) ?? 0) + 1)
  return after.syntaxErrors.find((p) => {
    const left = seen.get(p.key) ?? 0
    seen.set(p.key, left - 1)
    return left <= 0
  })
}

function syntaxMessage(e: SyntaxProblem, text: string): string {
  const lineText = text.split('\n')[e.line - 1] ?? ''
  return `${e.message} at line ${e.line}:${e.column + 1}\n  ${e.line} | ${lineText}\n  ${' '.repeat(String(e.line).length)} | ${' '.repeat(e.column)}^`
}

/** The text between two offsets with 1-based line numbers, capped. */
function numbered(text: string, from: number, to: number): string {
  const first = lineOf(text, from)
  const lines = text.slice(lineStart(text, from), lineEnd(text, to)).split('\n')
  const width = String(first + lines.length - 1).length
  const shown = lines.slice(0, SHOW_LINES).map((l, i) => `${String(first + i).padStart(width)} | ${l}`)
  if (lines.length > SHOW_LINES) shown.push(`… ${lines.length - SHOW_LINES} more lines`)
  return shown.join('\n')
}
