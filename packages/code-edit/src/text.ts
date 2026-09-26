// Text helpers for the edit engine. All offsets index LF-normalised text.

import { diffArrays } from 'diff'

/** A source file split into its edit form (no BOM, LF endings) plus what restores it. */
export interface NormalisedSource {
  text: string
  bom: boolean
  /** Most lines end CRLF, so new lines do too. */
  crlf: boolean
  /** Each line's own ending, kept only when the file mixes LF and CRLF. */
  endings?: string[]
}

export function normaliseSource(raw: string): NormalisedSource {
  const bom = raw.charCodeAt(0) === 0xfeff
  const body = bom ? raw.slice(1) : raw
  const endings = body.match(/\r?\n/g) ?? []
  const crlfCount = endings.filter((e) => e === '\r\n').length
  const mixed = crlfCount > 0 && crlfCount < endings.length
  return {
    text: body.replace(/\r\n/g, '\n'),
    bom,
    crlf: crlfCount > endings.length - crlfCount,
    ...(mixed ? { endings } : {})
  }
}

export function restoreSource(text: string, source: NormalisedSource): string {
  const eol = source.crlf ? '\r\n' : '\n'
  const body = source.endings ? keepEndings(source.text, text, source.endings, eol) : text.replace(/\n/g, eol)
  return source.bom ? '\uFEFF' + body : body
}

/** `after`, where each line kept from `before` ends as it did there and every new line ends with `eol`. */
function keepEndings(before: string, after: string, endings: string[], eol: string): string {
  const lines: string[] = []
  const ends: string[] = []
  let old = 0
  for (const part of diffArrays(before.split('\n'), after.split('\n'))) {
    if (part.removed) {
      old += part.value.length
      continue
    }
    for (const line of part.value) {
      lines.push(line)
      ends.push(part.added ? eol : (endings[old++] ?? eol))
    }
  }
  return lines.map((line, i) => (i < lines.length - 1 ? line + ends[i] : line)).join('')
}

export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

/** Offset of the newline that ends the line holding `offset`, or text.length. */
export function lineEnd(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset)
  return nl === -1 ? text.length : nl
}

/** 1-based line number of `offset`. */
export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** Offset of a 1-based line and 0-based column. */
export function offsetOf(text: string, line: number, column: number): number {
  let pos = 0
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos)
    if (nl === -1) return text.length
    pos = nl + 1
  }
  return Math.min(pos + column, text.length)
}

/** Leading whitespace of the line holding `offset`. */
export function indentAt(text: string, offset: number): string {
  const start = lineStart(text, offset)
  return leadingSpace(text.slice(start, lineEnd(text, start)))
}

function leadingSpace(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

/** True when only spaces and tabs sit between the start of its line and `offset`. */
export function startsLine(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset))
}

/**
 * Re-base a code snippet onto `indent`. The first line is returned bare — it
 * lands where the old text began — and every later non-blank line gets
 * `indent` plus its indentation relative to the first line's. A line shallower
 * than the first moves the same distance left of `indent` (a Python dedent),
 * or stays as written when `indent` is too shallow for that (string text).
 */
export function reindent(code: string, indent: string): string {
  const lines = trimBlankEdges(code.replace(/\r\n/g, '\n')).split('\n')
  const base = leadingSpace(lines[0]) || flushLeftBase(lines)
  return lines
    .map((line, i) => {
      if (!line.trim()) return ''
      if (i === 0) return line.trimStart()
      if (line.startsWith(base)) return indent + line.slice(base.length)
      const own = leadingSpace(line)
      const drop = base.slice(own.length)
      return base.startsWith(own) && indent.endsWith(drop)
        ? indent.slice(0, indent.length - drop.length) + line.trimStart()
        : line
    })
    .join('\n')
}

/** The same snippet, indented as a whole block (first line included). */
export function indentBlock(code: string, indent: string): string {
  return indent + reindent(code, indent)
}

function trimBlankEdges(code: string): string {
  return code.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
}

/**
 * The base of a snippet whose first line has no indent. Agents often paste
 * code copied from inside a block with only the first line's indent stripped;
 * when the closing bracket and every line after the first keep an indent, that
 * indent is the base.
 */
function flushLeftBase(lines: string[]): string {
  const rest = lines.slice(1).filter((l) => l.trim())
  const indent = /^([ \t]+)[}\])]/.exec(rest[rest.length - 1] ?? '')?.[1]
  return indent && rest.every((l) => l.startsWith(indent)) ? indent : ''
}

function commonIndent(lines: string[]): string {
  let prefix: string | null = null
  for (const line of lines) {
    const ws = /^[ \t]*/.exec(line)![0]
    if (prefix === null) prefix = ws
    else {
      let i = 0
      while (i < prefix.length && i < ws.length && prefix[i] === ws[i]) i++
      prefix = prefix.slice(0, i)
    }
    if (!prefix) return ''
  }
  return prefix ?? ''
}

// ── Anchor matching ───────────────────────────────────────────────────────────

export interface AnchorHit {
  start: number
  end: number
  /** False when the match ignored indentation or surrounding whitespace. */
  exact: boolean
}

export class AnchorError extends Error {
  readonly reason: 'none' | 'many'
  /** Offsets (into the haystack) of each hit, when there were several. */
  readonly hits: number[]

  constructor(reason: 'none' | 'many', hits: number[] = []) {
    super(reason === 'none' ? 'no match' : `${hits.length} matches`)
    this.reason = reason
    this.hits = hits
  }
}

/**
 * Find `needle` in `hay` exactly once. Passes, first unique hit wins: exact
 * text; then indentation-insensitive (whole lines, any common indent, trailing
 * spaces ignored); then per-line whitespace-insensitive. Several hits in a
 * pass is an error, never a guess.
 */
export function findAnchor(hay: string, needle: string): AnchorHit {
  const n = needle.replace(/\r\n/g, '\n')
  if (!n.trim()) throw new AnchorError('none')
  const passes: Array<() => AnchorHit[]> = [
    () => substringHits(hay, n).map((start) => ({ start, end: start + n.length, exact: true })),
    () => (n.includes('\n') ? windowHits(hay, n, dedentedLines) : trimmedHits(hay, n)),
    () => (n.includes('\n') ? windowHits(hay, n, (lines) => lines.map((l) => l.trim())) : [])
  ]
  for (const pass of passes) {
    const hits = pass()
    if (hits.length === 1) return hits[0]
    if (hits.length > 1)
      throw new AnchorError(
        'many',
        hits.map((h) => h.start)
      )
  }
  throw new AnchorError('none')
}

function substringHits(hay: string, needle: string): number[] {
  const out: number[] = []
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

function trimmedHits(hay: string, needle: string): AnchorHit[] {
  const t = needle.trim()
  return t === needle ? [] : substringHits(hay, t).map((start) => ({ start, end: start + t.length, exact: false }))
}

function dedentedLines(lines: string[]): string[] {
  const base = commonIndent(lines.filter((l) => l.trim()))
  return lines.map((l) => (l.trim() ? l.slice(base.length).trimEnd() : ''))
}

/** Whole-line windows of `hay` whose lines equal the needle's under `norm`. */
function windowHits(hay: string, needle: string, norm: (lines: string[]) => string[]): AnchorHit[] {
  const want = norm(trimBlankEdges(needle).split('\n')).join('\n')
  const count = want.split('\n').length
  const starts = [0]
  for (let i = hay.indexOf('\n'); i !== -1; i = hay.indexOf('\n', i + 1)) starts.push(i + 1)
  const lines = hay.split('\n')
  const hits: AnchorHit[] = []
  for (let i = 0; i + count <= lines.length; i++) {
    if (norm(lines.slice(i, i + count)).join('\n') !== want) continue
    const first = lines[i]
    const last = lines[i + count - 1]
    const start = starts[i] + (first.length - first.trimStart().length)
    hits.push({ start, end: starts[i + count - 1] + last.trimEnd().length, exact: false })
  }
  return hits
}

// ── Leading comments and decorators in replacement code ──────────────────────

export interface CodeTraits {
  /** Tokens that open a comment: ['//', '/*'] or ['#']. */
  comment: string[]
  /** Tokens that open a decorator or attribute: ['@'] or ['#[']. */
  decorator: string[]
}

/** What a snippet opens with, which decides how much of the old declaration it replaces. */
export function leadingElement(code: string, traits: CodeTraits): 'comment' | 'decorator' | 'code' {
  const head = code.trimStart()
  if (traits.decorator.some((t) => head.startsWith(t))) return 'decorator'
  if (traits.comment.some((t) => head.startsWith(t))) return 'comment'
  return 'code'
}

/** Offset in `code` where the declaration begins, past leading comments and decorators. */
export function declarationHead(code: string, traits: CodeTraits): number {
  return leadingParts(code, traits).head
}

/** Where the declaration in `code` begins, past its leading comments and decorators, and whether a decorator is among them. */
export function leadingParts(code: string, traits: CodeTraits): { head: number; decorated: boolean } {
  let i = 0
  let decorated = false
  for (;;) {
    while (i < code.length && /\s/.test(code[i])) i++
    const rest = code.slice(i)
    const deco = traits.decorator.find((t) => rest.startsWith(t))
    if (deco) {
      i = skipDecorator(code, i + deco.length, deco === '#[')
      decorated = true
      continue
    }
    const comment = traits.comment.find((t) => rest.startsWith(t))
    if (!comment) return { head: i, decorated }
    if (comment === '/*') {
      const close = code.indexOf('*/', i + 2)
      i = close === -1 ? code.length : close + 2
    } else {
      i = lineEnd(code, i)
    }
  }
}

// ── Comments after a declaration, on its last line ───────────────────────────

/** True when `rest` is one comment and nothing else: `// x`, `# x`, or a block comment closed on the line. */
function isComment(rest: string, traits: CodeTraits): boolean {
  const r = rest.trim()
  return traits.comment.some((t) => r.startsWith(t) && (t !== '/*' || r.indexOf('*/', 2) === r.length - 2))
}

/** Offset past a comment that follows `offset` on its line (`x = 1 // why`), else `offset`. */
export function trailingCommentEnd(text: string, offset: number, traits: CodeTraits): number {
  const eol = lineEnd(text, offset)
  return isComment(text.slice(offset, eol), traits) ? eol : offset
}

/** True when only a list separator (`,` or `;`) and a comment, each optional, follow `offset` on its line. */
export function endsLine(text: string, offset: number, traits: CodeTraits): boolean {
  const rest = text.slice(offset, lineEnd(text, offset)).replace(/^[ \t]*[,;]?/, '')
  return !rest.trim() || isComment(rest, traits)
}

/** True when a snippet's last line ends with a comment: a comment token after a space, no quote after it. */
export function endsWithComment(code: string, traits: CodeTraits): boolean {
  const last = code.trimEnd().split('\n').pop()!
  return traits.comment.some((t) => new RegExp(`(?:^|\\s)${t.replace('*', '\\*')}[^'"\`]*$`).test(last))
}

/** Past a decorator body: a dotted name plus balanced brackets, or up to `]` for Rust attributes. */
function skipDecorator(code: string, i: number, bracketed: boolean): number {
  let depth = bracketed ? 1 : 0
  while (i < code.length) {
    const c = code[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0 && bracketed) return i + 1
    } else if (depth === 0 && /\s/.test(c)) return i
    i++
  }
  return i
}
