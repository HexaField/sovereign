// A zero-context unified diff (`git diff -U0 -M`) as changed files with their
// hunks: what the structure of a change needs to tell an edited symbol from one
// that only moved down the file.

import type { ChangedFile, Hunk } from '../ports.js'

/** Git's C-style quoting of a path with unusual characters (`"a/t\303\244b.ts"`) */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"')) return s
  const body = s.slice(1, -1)
  const bytes: number[] = []
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = body[i + 1]
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0))
      i += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** `a/x` → `x`; `/dev/null` → null */
function sidePath(s: string): string | null {
  const p = unquote(s.trim())
  if (p === '/dev/null') return null
  return p.replace(/^[ab]\//, '')
}

/** `diff --git a/P b/P` for an unchanged path: both halves are equal, so P is half of what is left */
function pathOfGitLine(line: string): string | null {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*"|\S.*)$/.exec(rest)
    return m ? sidePath(m[2]) : null
  }
  const half = (rest.length - 1) / 2
  if (!Number.isInteger(half)) return null
  const a = rest.slice(0, half)
  const b = rest.slice(half + 1)
  return a.slice(2) === b.slice(2) ? b.slice(2) : null
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Changed files of `git diff -U0 -M` output, in diff order. Content lines are skipped; only hunk headers count. */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = []
  let cur: { file: ChangedFile; from: string | null; to: string | null; created: boolean; deleted: boolean } | null =
    null

  const finish = () => {
    if (!cur) return
    const { file, from, to, created, deleted } = cur
    if (created || from === null) file.status = 'added'
    else if (deleted || to === null) file.status = 'deleted'
    if (file.status === 'deleted' && from) file.path = from
    else if (to) file.path = to
    if (file.status === 'renamed' && from && from !== file.path) file.oldPath = from
    else if (file.status === 'renamed') file.status = 'modified'
    if (file.path) files.push(file)
    cur = null
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish()
      const p = pathOfGitLine(line)
      cur = { file: { path: p ?? '', status: 'modified', hunks: [] }, from: p, to: p, created: false, deleted: false }
      continue
    }
    if (!cur) continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      const h: Hunk = {
        baseStart: Number(hunk[1]),
        baseLines: hunk[2] === undefined ? 1 : Number(hunk[2]),
        headStart: Number(hunk[3]),
        headLines: hunk[4] === undefined ? 1 : Number(hunk[4])
      }
      cur.file.hunks.push(h)
      continue
    }
    if (cur.file.hunks.length > 0) continue // content lines
    if (line.startsWith('new file mode')) cur.created = true
    else if (line.startsWith('deleted file mode')) cur.deleted = true
    else if (line.startsWith('rename from ')) {
      cur.from = unquote(line.slice('rename from '.length))
      cur.file.status = 'renamed'
    } else if (line.startsWith('rename to ')) {
      cur.to = unquote(line.slice('rename to '.length))
      cur.file.status = 'renamed'
    } else if (line.startsWith('--- ')) cur.from = sidePath(line.slice(4))
    else if (line.startsWith('+++ ')) cur.to = sidePath(line.slice(4))
  }
  finish()
  return files
}

/** The 1-based lines a hunk side covers; a side with no lines covers none */
export function hunkLines(start: number, count: number): [number, number] | null {
  return count === 0 ? null : [start, start + count - 1]
}
