// Symbol names → declarations. A name matches when it equals the tail of a
// qualified name at a `::` boundary; `.` is accepted for `::`; `@<line>`
// picks between same-named declarations. Never guesses.

import { EditError, type Declaration } from './types.js'

const LIST_CAP = 40

export function resolveSymbol(declarations: Declaration[], query: string, fileLabel: string): Declaration {
  const m = /^(.*?)(?:@(\d+))?$/.exec(query.trim())!
  const path = m[1].split(/::|\./).filter(Boolean)
  const line = m[2] ? Number(m[2]) : undefined
  if (path.length === 0) throw new EditError(`Empty symbol name: '${query}'.`)

  let found = declarations.filter((d) => endsWith(d.qualifiedName.split('::'), path))
  if (line !== undefined && found.length > 0) {
    const within = found.filter((d) => d.startLine <= line && line <= d.endLine)
    // Nested same-named symbols can both contain the line: take the innermost.
    found = within.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine)).slice(0, 1)
    if (found.length === 0) {
      throw new EditError(
        `No '${m[1]}' spans line ${line} in ${fileLabel}. Candidates:\n${list(declarations.filter((d) => endsWith(d.qualifiedName.split('::'), path)))}`
      )
    }
  }
  if (found.length === 1) return found[0]
  if (found.length > 1) {
    throw new EditError(
      `'${m[1]}' matches ${found.length} declarations in ${fileLabel}. Add @<line> to pick one, e.g. '${m[1]}@${found[1].line}':\n${list(found)}`
    )
  }
  const hint = didYouMean(declarations, path[path.length - 1])
  throw new EditError(
    declarations.length === 0
      ? `No symbols found in ${fileLabel}.`
      : `No symbol '${m[1]}' in ${fileLabel}.${hint ? ` Did you mean '${hint}'?` : ''} Symbols:\n${list(declarations)}`
  )
}

function endsWith(qualified: string[], path: string[]): boolean {
  if (path.length > qualified.length) return false
  const offset = qualified.length - path.length
  return path.every((seg, i) => qualified[offset + i] === seg)
}

export function describe(d: Declaration): string {
  return `${d.qualifiedName} (${d.kind}, line ${d.line})`
}

function list(declarations: Declaration[]): string {
  const shown = declarations.slice(0, LIST_CAP).map((d) => `  ${describe(d)}`)
  if (declarations.length > LIST_CAP) shown.push(`  … ${declarations.length - LIST_CAP} more`)
  return shown.join('\n')
}

function didYouMean(declarations: Declaration[], wanted: string): string | undefined {
  const w = wanted.toLowerCase()
  const limit = Math.max(2, Math.ceil(w.length * 0.4))
  let best: { name: string; score: number } | undefined
  for (const d of declarations) {
    const name = d.name.toLowerCase()
    const score = name.includes(w) || w.includes(name) ? 0.5 : editDistance(w, name)
    if (score <= limit && (!best || score < best.score)) best = { name: d.qualifiedName, score }
  }
  return best?.name
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    }
    prev = cur
  }
  return prev[b.length]
}
