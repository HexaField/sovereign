// Quick-open file search: list every file under a root (ripgrep, honouring
// .gitignore; a plain walk when ripgrep is missing), cache the list briefly,
// and rank paths against a query the way an editor's "Go to File" does.

import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as nodePath from 'node:path'
import * as os from 'node:os'

/** Directories the fallback walk never enters (ripgrep uses .gitignore instead). */
const WALK_SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  '.cache'
])

/** Most files one list holds; past this the walk stops and the list says so. */
const MAX_FILES = 500_000

export interface FileList {
  /** Paths relative to the root, `/`-separated. */
  files: string[]
  truncated: boolean
}

function rgCandidates(): string[] {
  return [
    'rg',
    nodePath.join(os.homedir(), '.local/bin/rg'),
    '/usr/bin/rg',
    '/usr/local/bin/rg',
    '/opt/homebrew/bin/rg'
  ]
}

function listWithRg(bin: string, root: string): Promise<FileList> {
  return new Promise((resolve, reject) => {
    // NUL-separated so a file name holding a newline stays one entry; stderr ignored so it cannot fill and stall rg.
    const child = spawn(bin, ['--files', '--hidden', '--null', '--no-messages', '-g', '!.git'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const files: string[] = []
    let rest = ''
    let truncated = false
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return
      const names = (rest + chunk).split('\0')
      rest = names.pop() ?? ''
      for (const name of names) {
        if (!name) continue
        if (files.length >= MAX_FILES) {
          truncated = true
          child.kill()
          return
        }
        files.push(name.startsWith('./') ? name.slice(2) : name)
      }
    })
    child.on('error', reject)
    // rg exits 1 when it finds no files and 2 on partial read errors; both still list what it saw.
    child.on('close', () => {
      if (rest && !truncated) {
        if (files.length < MAX_FILES) files.push(rest)
        else truncated = true
      }
      resolve({ files, truncated })
    })
  })
}

async function listWithWalk(root: string): Promise<FileList> {
  const files: string[] = []
  let truncated = false
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true
        return
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) await walk(nodePath.join(dir, e.name), relPath)
      } else if (e.isFile()) {
        files.push(relPath)
      }
    }
  }
  await walk(root, '')
  return { files, truncated }
}

/** Every file under `root`. Tries ripgrep first, then a plain walk. */
export async function listFiles(root: string): Promise<FileList> {
  // A missing root also fails rg's spawn with ENOENT; check it first so that is not read as "no rg".
  await fs.access(root)
  for (const bin of rgCandidates()) {
    try {
      return await listWithRg(bin, root)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  return listWithWalk(root)
}

/** Caches one list per root; a stale list is served while a fresh one builds. */
export function createFileListCache(opts: { ttlMs?: number; list?: (root: string) => Promise<FileList> } = {}) {
  const ttl = opts.ttlMs ?? 30_000
  const list = opts.list ?? listFiles
  const cache = new Map<string, { value?: FileList; at: number; pending?: Promise<FileList> }>()

  function refresh(root: string): Promise<FileList> {
    const entry = cache.get(root) ?? { at: 0 }
    if (entry.pending) return entry.pending
    entry.pending = list(root)
      .then((value) => {
        cache.set(root, { value, at: Date.now() })
        return value
      })
      .catch((err) => {
        entry.pending = undefined
        throw err
      })
    cache.set(root, entry)
    return entry.pending
  }

  return {
    async get(root: string): Promise<FileList> {
      const entry = cache.get(root)
      if (entry?.value) {
        if (Date.now() - entry.at > ttl) void refresh(root).catch(() => {})
        return entry.value
      }
      return refresh(root)
    }
  }
}

export interface FileMatch {
  path: string
  score: number
  /** Indices into `path` of the matched query characters. */
  positions: number[]
}

const SEPARATORS = new Set(['/', '\\', '-', '_', '.', ' '])

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  if (SEPARATORS.has(prev)) return true
  return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase()
}

/** True when `query` from `qi` on appears in `lower`, in order, from `offset` on. */
function isSubsequence(query: string, lower: string, offset: number, qi = 0): boolean {
  let i = offset
  for (; qi < query.length; qi++) {
    i = lower.indexOf(query[qi], i)
    if (i < 0) return false
    i++
  }
  return true
}

/**
 * Best in-order match of `query` in `text` from `offset` on. Each query
 * character takes the next word-start or run-continuing occurrence when one
 * exists, else the next plain one; word starts and runs score more.
 */
function matchIn(
  query: string,
  text: string,
  lower: string,
  offset: number
): { score: number; positions: number[] } | null {
  if (!isSubsequence(query, lower, offset)) return null
  const positions: number[] = []
  let score = 0
  let ti = offset
  for (let qi = 0; qi < query.length; qi++) {
    const c = query[qi]
    const prev = positions[positions.length - 1]
    let found = -1
    let firstPlain = -1
    for (let j = ti; j < lower.length; j++) {
      if (lower[j] !== c) continue
      if (firstPlain < 0) firstPlain = j
      if (isBoundary(text, j) || j === prev + 1) {
        // A later pick must leave the rest matchable; if this one does not, no later one will.
        if (isSubsequence(query, lower, j + 1, qi + 1)) found = j
        break
      }
    }
    if (found < 0) found = firstPlain
    score += 1
    if (prev !== undefined && found === prev + 1) score += 5
    if (isBoundary(text, found)) score += 4
    positions.push(found)
    ti = found + 1
  }
  return { score, positions }
}

/** Score one path against a query, or null when the query does not match. */
export function scorePath(rawQuery: string, path: string, lower = foldCase(path)): FileMatch | null {
  const query = normaliseQuery(rawQuery)
  if (!query) return { path, score: 0, positions: [] }
  const base = path.lastIndexOf('/') + 1
  // A query without a slash should match the file name if it can.
  if (!query.includes('/')) {
    const inName = matchIn(query, path, lower, base)
    if (inName) {
      let score = inName.score + 20
      if (inName.positions[0] === base) score += 10
      if (path.length - base === query.length) score += 15
      return { path, score: score - path.length / 100, positions: inName.positions }
    }
  }
  const whole = matchIn(query, path, lower, 0)
  if (!whole) return null
  return { path, score: whole.score - path.length / 100, positions: whole.positions }
}

function normaliseQuery(q: string): string {
  return foldCase(q.replace(/\s+/g, ''))
}

/**
 * Lowercase one character at a time, keeping the length: an index into the
 * result is an index into `s`. A character whose lowercase form is longer
 * (`İ` → `i̇`) stays as it is, and `Σ` always folds to `σ`, so a path and a
 * query fold alike.
 */
export function foldCase(s: string): string {
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase()
  let out = ''
  for (const ch of s) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

/** Lowercased copies of each cached file list, so a keystroke does not redo them. */
const lowered = new WeakMap<string[], string[]>()

function lowerOf(files: string[]): string[] {
  let l = lowered.get(files)
  if (!l) {
    l = files.map(foldCase)
    lowered.set(files, l)
  }
  return l
}

/** Higher score first; ties go to the shorter, then alphabetically earlier, path. */
const byRank = (a: FileMatch, b: FileMatch) =>
  b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)

/** The best `limit` matches, highest score first; ties go to the shorter path. */
export function searchFiles(files: string[], query: string, limit = 50): { matches: FileMatch[]; total: number } {
  const q = normaliseQuery(query)
  const lower = lowerOf(files)
  // Keep only the best `limit` (sorted) while scanning: short queries match almost every file.
  const top: FileMatch[] = []
  let total = 0
  for (let i = 0; i < files.length; i++) {
    if (q && !isSubsequence(q, lower[i], 0)) continue
    const m = scorePath(q, files[i], lower[i])
    if (!m) continue
    total++
    if (top.length === limit && byRank(m, top[limit - 1]) >= 0) continue
    let at = top.length
    while (at > 0 && byRank(m, top[at - 1]) < 0) at--
    top.splice(at, 0, m)
    if (top.length > limit) top.pop()
  }
  return { matches: top, total }
}
