// Plans — markdown files in a membrane's plan directories become future
// nodes. Title from the first heading, done from a "Status:" line, edges from
// the references in the text: full GitHub URLs, "owner/repo#N", and a bare
// "#N" only when the file names exactly one repo (plans must name their repo).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PlanDir } from './scope.js'

export type PlanStatus = 'planned' | 'in_progress' | 'done'

export interface PlanRef {
  host: string
  repo: string
  number: number
  /** Known from a URL (pull vs issues); a short reference cannot tell. */
  kind?: 'change' | 'issue'
}

export interface Plan {
  /** "plan:<project>/<path relative to its plan dir>". */
  id: string
  project: string
  /** Absolute path. */
  file: string
  title: string
  status: PlanStatus
  refs: PlanRef[]
  hash: string
  updatedAt: string
  createdAt: string
}

const URL_RE = /https?:\/\/([a-z0-9.-]+)\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/gi
const SHORT_RE = /(?<![\w/.-])([\w.-]+)\/([\w.-]+)#(\d+)\b/g
const BARE_RE = /(?<![\w/#&])#(\d+)\b/g
const REPO_NAME_RE = /(?<![\w/.:-])([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)(?![\w/-])/g
const REPO_LINE_RE = /^\s*\**repo\**:?\**\s*`?([\w.-]+\/[\w.-]+)`?/im

export function planStatus(text: string): PlanStatus {
  const m = /\bstatus\**\s*:\s*\**\s*([^\n.;*|]+)/i.exec(text)
  if (!m) return 'planned'
  const v = m[1].trim().toLowerCase()
  if (/^(done|complete|completed|shipped|landed|merged|finished|closed)\b/.test(v)) return 'done'
  if (/^(in[ -]progress|building|started|underway|wip|active)\b/.test(v)) return 'in_progress'
  return 'planned'
}

export function planTitle(text: string, fallback: string): string {
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (m) return m[1].trim()
  }
  return fallback
}

/** Strip fenced code blocks, whose "#N" are rarely references. */
function prose(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, '')
}

/**
 * References in a plan's text. A bare "#N" links only when the file names
 * its repo: a `Repo: owner/name` line, or exactly one repo of `knownRepos`
 * named in plain text (a reference like "owner/name#N" names an item, not
 * the file's repo).
 */
export function planRefs(text: string, knownRepos: string[] = [], defaultHost = 'github.com'): PlanRef[] {
  const out = new Map<string, PlanRef>()
  const put = (r: PlanRef) => {
    const k = `${r.host}/${r.repo}#${r.number}`
    const prev = out.get(k)
    if (!prev || (!prev.kind && r.kind)) out.set(k, r)
  }
  const body = prose(text)
  const known = new Map(knownRepos.map((r) => [r.toLowerCase(), r]))

  for (const m of body.matchAll(URL_RE)) {
    put({
      host: m[1].toLowerCase(),
      repo: `${m[2]}/${m[3]}`,
      number: Number(m[5]),
      kind: m[4].toLowerCase() === 'pull' ? 'change' : 'issue'
    })
  }
  const noUrls = body.replace(URL_RE, ' ')
  for (const m of noUrls.matchAll(SHORT_RE)) {
    const repo = known.get(`${m[1]}/${m[2]}`.toLowerCase()) ?? `${m[1]}/${m[2]}`
    put({ host: defaultHost, repo, number: Number(m[3]) })
  }
  const plain = noUrls.replace(SHORT_RE, ' ')

  const line = REPO_LINE_RE.exec(body)
  let home: string | undefined = line ? (known.get(line[1].toLowerCase()) ?? line[1]) : undefined
  if (!home) {
    const named = new Set<string>()
    for (const m of plain.matchAll(REPO_NAME_RE)) {
      // A sentence may end right after the name: "… in owner/name."
      const k = known.get(`${m[1]}/${m[2].replace(/\.+$/, '')}`.toLowerCase())
      if (k) named.add(k)
    }
    if (named.size === 1) home = [...named][0]
  }
  if (home) {
    for (const m of plain.matchAll(BARE_RE)) put({ host: defaultHost, repo: home, number: Number(m[1]) })
  }
  return [...out.values()]
}

export function parsePlan(
  text: string,
  opts: { project: string; rel: string; file: string; knownRepos?: string[]; mtime: Date; birthtime?: Date }
): Plan {
  return {
    id: `plan:${opts.project}/${opts.rel}`,
    project: opts.project,
    file: opts.file,
    title: planTitle(text, path.basename(opts.rel, path.extname(opts.rel))),
    status: planStatus(text),
    refs: planRefs(text, opts.knownRepos),
    hash: crypto.createHash('sha1').update(text).digest('hex'),
    updatedAt: opts.mtime.toISOString(),
    createdAt: (opts.birthtime && opts.birthtime.getTime() > 0 ? opts.birthtime : opts.mtime).toISOString()
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build'])

function listMarkdown(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3) return out
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) listMarkdown(full, depth + 1, out)
    } else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(full)
  }
  return out
}

/** Every plan under these dirs. A file under two dirs counts once (first dir wins). */
export function scanPlans(dirs: PlanDir[], knownRepos: string[] = []): Plan[] {
  const out: Plan[] = []
  const seen = new Set<string>()
  for (const d of dirs) {
    for (const file of listMarkdown(d.dir)) {
      if (seen.has(file)) continue
      seen.add(file)
      let text: string
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
        if (stat.size > 2_000_000) continue
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const repos = d.repo && !knownRepos.includes(d.repo) ? [...knownRepos, d.repo] : knownRepos
      out.push(
        parsePlan(text, {
          project: d.project,
          rel: path.relative(d.dir, file).split(path.sep).join('/'),
          file,
          knownRepos: repos,
          mtime: stat.mtime,
          birthtime: stat.birthtime
        })
      )
    }
  }
  return out
}

/** True when a changed path lies under one of the plan dirs and is markdown. */
export function isPlanPath(dirs: PlanDir[], file: string): boolean {
  if (!/\.(md|markdown)$/i.test(file)) return false
  return dirs.some((d) => file === d.dir || file.startsWith(d.dir + path.sep))
}
