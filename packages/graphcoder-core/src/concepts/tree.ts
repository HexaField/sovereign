// The concept tree: a folder of Markdown pages, committed with the code, that
// says what the system is (ad4m's `mental-models/`; the rules are in its
// CONVENTIONS.md). `folder/README.md` is a node, `file.md` a leaf. Each page
// has a title, a one-paragraph model, a Why, and two collapsed blocks:
// "How it works" (numbered steps: the page's flows) and "Where in the code"
// (relative links to files and directories, and backticked symbol names: the
// page's claims on the code). Graphcoder reads the tree as its map of the code
// (map.ts) instead of keeping one of its own.

import type { RepoFiles } from '../ports.js'

/** Where a repo keeps its concept tree unless `.graphcoder/config.json` names another folder (`conceptDir`) */
export const DEFAULT_CONCEPT_DIR = 'mental-models'
export const CONFIG_FILE = '.graphcoder/config.json'

/** A file or directory a page links in "Where in the code" */
export interface PathClaim {
  /** Repo-relative, no trailing slash */
  path: string
  /** What the path is in the repo; `missing`: the link is stale */
  kind: 'file' | 'dir' | 'missing'
}

/** A backticked symbol name in "Where in the code" */
export interface SymbolClaim {
  /** `Name` or `Outer::name`; a dot reads as `::` */
  name: string
  /** The paths the same bullet links: where the symbol is looked for first */
  scope: string[]
}

export interface FlowStep {
  /** The step's Markdown, links reduced to their labels */
  text: string
  symbols: string[]
}

/** A numbered list in "How it works", under the line that introduces it */
export interface ConceptFlow {
  title: string
  steps: FlowStep[]
}

export interface ConceptPage {
  /** The page's place in the tree: its path under the tree folder without `.md` or `/README.md`; `''` for the root */
  id: string
  /** Repo-relative page file */
  file: string
  /** The nearest ancestor page; null for a root */
  parent: string | null
  /** Child pages: in the order the page's Parts list links them, then by id */
  children: string[]
  /** Folders between the tree folder and the page: 0 for the root README */
  depth: number
  title: string
  /** The page's first paragraph: what the thing is and does */
  model: string
  why: string
  paths: PathClaim[]
  symbols: SymbolClaim[]
  flows: ConceptFlow[]
}

export interface ConceptTree {
  /** Repo-relative tree folder */
  dir: string
  /** Every page, parents before children (pre-order) */
  pages: ConceptPage[]
}

/** Is page `a` an ancestor of page `b`? (By id: the root `''` is everyone's.) */
export function isAncestor(a: string, b: string): boolean {
  return a !== b && (a === '' || b.startsWith(`${a}/`))
}

/** The page's title with its ancestors', root left out (the root alone is its own title): "Agents › Access › Sessions" */
export function breadcrumb(tree: ConceptTree, id: string): string {
  const byId = new Map(tree.pages.map((p) => [p.id, p]))
  const titles: string[] = []
  for (let p = byId.get(id); p; p = p.parent === null ? undefined : byId.get(p.parent)) {
    if (p.id !== '' || titles.length === 0) titles.unshift(p.title)
  }
  return titles.join(' › ')
}

/** The folder of the repo's concept tree: `conceptDir` in `.graphcoder/config.json`, else `mental-models` */
export async function conceptDirOf(files: RepoFiles): Promise<string> {
  const text = await files.read(CONFIG_FILE)
  if (text === null) return DEFAULT_CONCEPT_DIR
  let config: { conceptDir?: unknown }
  try {
    config = JSON.parse(text) as { conceptDir?: unknown }
  } catch (err) {
    throw new Error(`${CONFIG_FILE}: ${(err as Error).message}`)
  }
  if (config.conceptDir === undefined) return DEFAULT_CONCEPT_DIR
  const dir = typeof config.conceptDir === 'string' ? normalizePath(config.conceptDir.replace(/^\.\//, '')) : null
  if (!dir) throw new Error(`${CONFIG_FILE}: conceptDir must name a folder inside the repo`)
  return dir
}

/** A `/`-separated path with `.` and `..` resolved; null when it leaves the root or is empty or absolute */
function normalizePath(p: string): string | null {
  if (p.startsWith('/')) return null
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(seg)
  }
  return out.length > 0 ? out.join('/') : null
}

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** File extensions that mark a backticked word as a file name rather than a symbol */
const FILE_NAME = /\.(rs|[cm]?[jt]sx?|py|go|java|kt|swift|c|h|cpp|md|mdx|json|toml|ya?ml|sh|css|html|sql|proto|lock)$/i
const NAME = /^[A-Za-z_$][\w$]*((::|\.)[A-Za-z_$][\w$]*)*$/

/**
 * The symbol names one backticked span holds: `A::{b, c}` names `A::b` and `A::c`; a call's arguments and a type's
 * generics drop (`Order.total()` → `Order::total`); a dot reads as `::`. File names, paths and anything else that is
 * not a name hold none.
 */
export function symbolNames(span: string): string[] {
  const group = /^(.*)::\{([^}]*)\}$/.exec(span.trim())
  const parts = group ? group[2].split(',').map((x) => `${group[1]}::${x.trim()}`) : [span.trim()]
  return parts
    .map((t) =>
      t
        .replace(/\(.*\)$/, '')
        .replace(/<.*>$/, '')
        .trim()
    )
    .filter((t) => NAME.test(t) && !FILE_NAME.test(t))
    .map((t) => t.replace(/\./g, '::'))
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g
const withLabels = (s: string) => s.replace(LINK, '$1')
const plain = (s: string) =>
  withLabels(s)
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const backticked = (s: string) => [...s.matchAll(/`([^`]+)`/g)].flatMap((m) => symbolNames(m[1]))

/** The body of `<details><summary>{summary}</summary> … </details>`, or '' */
function details(text: string, summary: string): string {
  const m = new RegExp(`<summary>\\s*${summary}\\s*</summary>([\\s\\S]*?)</details>`, 'i').exec(text)
  return m ? m[1] : ''
}

/** Lines outside fenced code blocks */
function outsideFences(text: string): string[] {
  let fenced = false
  return text.split('\n').filter((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      return false
    }
    return !fenced
  })
}

/** List items and paragraphs, each with its continuation lines */
function items(text: string): string[] {
  const out: string[][] = []
  let current: string[] | null = null
  for (const line of outsideFences(text)) {
    if (line.trim() === '') current = null
    else if (!current || /^\s*([-*+]|\d+\.)\s/.test(line)) out.push((current = [line.trim()]))
    else current.push(line.trim())
  }
  return out.map((lines) => lines.join(' '))
}

/** The page's "## Parts" section, up to the next heading or collapsed block */
function partsSection(text: string): string {
  const start = /^##\s+Parts\s*$/m.exec(text)
  if (!start) return ''
  const rest = text.slice(start.index + start[0].length)
  const end = /^#|<details/m.exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

/** Repo-relative targets of a page's relative links; links out of the repo, into the tree, or elsewhere drop */
function linkTargets(text: string, pageFile: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(LINK)) {
    let href = m[2].replace(/#.*$/, '')
    if (href === '' || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue
    try {
      href = decodeURIComponent(href)
    } catch {
      /* keep it as written */
    }
    const target = normalizePath(`${dirname(pageFile)}/${href}`)
    if (target) out.push(target)
  }
  return out
}

/** The page's own text, before its existence checks and its place in the tree are known */
interface ParsedPage {
  title: string
  model: string
  why: string
  /** Linked targets per "Where in the code" item, with the item's symbol names */
  claims: Array<{ targets: string[]; symbols: string[] }>
  flows: ConceptFlow[]
  /** Pages the Parts list links, repo-relative */
  parts: string[]
}

function parsePage(text: string, file: string): ParsedPage {
  const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? ''
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
  const headIndex = blocks.findIndex((b) => /^#\s/.test(b))
  let model = ''
  for (const b of blocks.slice(headIndex + 1)) {
    if (/^(##|<details)/.test(b)) break
    if (/^\*\*[^*]+:\*\*/.test(b) || /^[#|<-]/.test(b)) continue
    model = plain(b)
    break
  }
  const whyBlock = blocks.find((b) => b.startsWith('**Why:**'))
  const why = whyBlock ? plain(whyBlock.slice('**Why:**'.length)) : ''

  const claims = items(details(text, 'Where in the code')).map((item) => ({
    targets: linkTargets(item, file),
    symbols: backticked(item.replace(LINK, ''))
  }))

  const flows: ConceptFlow[] = []
  let flow: ConceptFlow | null = null
  for (const raw of outsideFences(details(text, 'How it works'))) {
    const line = raw.trim()
    if (/^\d+\.\s/.test(line)) {
      if (!flow) flows.push((flow = { title: '', steps: [] }))
      const step = withLabels(line.replace(/^\d+\.\s+/, ''))
      flow.steps.push({ text: step, symbols: backticked(step) })
    } else if (line.endsWith(':') && !/^[|#*+-]/.test(line)) {
      flows.push((flow = { title: plain(line.slice(0, -1)).replace(/`/g, ''), steps: [] }))
    } else if (/^[|#]/.test(line)) flow = null
  }

  return {
    title,
    model,
    why,
    claims,
    flows: flows.filter((f) => f.steps.length > 0),
    parts: linkTargets(partsSection(text), file)
  }
}

/** A page file: `README.md`, or a lowercase kebab-case `.md` (tree docs such as CONVENTIONS.md are not pages) */
const isPageName = (name: string) => name === 'README.md' || /^[a-z0-9][a-z0-9-]*\.md$/.test(name)

/** The repo's concept tree under `dir`, or null when the folder holds no page */
export async function readConceptTree(files: RepoFiles, dir = DEFAULT_CONCEPT_DIR): Promise<ConceptTree | null> {
  const root = normalizePath(dir)
  if (!root) throw new Error(`Not a folder inside the repo: ${dir}`)

  const parsed = new Map<string, ParsedPage & { file: string }>()
  const walk = async (folder: string): Promise<void> => {
    for (const name of await files.list(folder)) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const rel = `${folder}/${name}`
      if (name.endsWith('.md')) {
        if (!isPageName(name)) continue
        const text = await files.read(rel)
        if (text === null) continue
        const id = rel
          .slice(root.length + 1)
          .replace(/(^|\/)README\.md$/, '')
          .replace(/\.md$/, '')
        parsed.set(id, { ...parsePage(text, rel), file: rel })
      } else await walk(rel)
    }
  }
  await walk(root)
  if (parsed.size === 0) return null

  // One existence check per linked path, shared by every page that links it
  const kinds = new Map<string, Promise<PathClaim['kind']>>()
  const kindOf = (p: string) => {
    let k = kinds.get(p)
    if (!k) {
      k = (async () => {
        if ((await files.read(p)) !== null) return 'file'
        return (await files.list(p)).length > 0 ? 'dir' : 'missing'
      })()
      kinds.set(p, k)
    }
    return k
  }
  const inTree = (p: string) => p === root || p.startsWith(`${root}/`)

  const pages = new Map<string, ConceptPage>()
  for (const [id, page] of parsed) {
    let parent: string | null = null
    for (let up = id; up !== '' && parent === null; ) {
      up = dirname(up)
      if (parsed.has(up)) parent = up
    }
    const paths: PathClaim[] = []
    const symbols: SymbolClaim[] = []
    const seenSymbols = new Set<string>()
    for (const claim of page.claims) {
      const scope = [...new Set(claim.targets.filter((t) => !inTree(t)))]
      for (const path of scope) {
        if (!paths.some((p) => p.path === path)) paths.push({ path, kind: await kindOf(path) })
      }
      for (const name of claim.symbols) {
        const key = `${name}\u0000${scope.join('\u0000')}`
        if (seenSymbols.has(key)) continue
        seenSymbols.add(key)
        symbols.push({ name, scope })
      }
    }
    pages.set(id, {
      id,
      file: page.file,
      parent,
      children: [],
      depth: id === '' ? 0 : id.split('/').length,
      title: page.title || id.split('/').pop() || root.split('/').pop()!,
      model: page.model,
      why: page.why,
      paths,
      symbols,
      flows: page.flows
    })
  }

  // Children in the order the parent's Parts list links them, then by id
  for (const page of pages.values()) {
    if (page.parent === null) continue
    pages.get(page.parent)!.children.push(page.id)
  }
  for (const page of pages.values()) {
    const order = parsed.get(page.id)!.parts
    const rank = (id: string) => {
      const i = order.indexOf(pages.get(id)!.file)
      return i === -1 ? Infinity : i
    }
    page.children.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
  }

  const ordered: ConceptPage[] = []
  const visit = (page: ConceptPage) => {
    ordered.push(page)
    for (const c of page.children) visit(pages.get(c)!)
  }
  for (const page of [...pages.values()].filter((p) => p.parent === null).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    visit(page)
  }
  return { dir: root, pages: ordered }
}
