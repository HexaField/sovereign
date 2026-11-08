// Concept impact (P1b): what a change does to the concept tree. A page the
// change adds, edits or removes is a model shift; changed symbols the code →
// concept map places on a page are its code touch. Code touched under a page
// that did not change asks "stale page?"; a page changed with no code under it
// is a docs-only shift.

import type { ChangeConcepts, ConceptText, ConceptTouch, TestRef } from '../contract.js'
import { byCodeUnit } from '../diff/compute.js'
import type { GraphNode } from '../graph.js'
import type { ChangedFile } from '../ports.js'
import type { SymbolChanges } from '../structure/changes.js'
import type { ConceptMap } from './map.js'
import { isAncestor, type ConceptPage } from './tree.js'

export interface ConceptImpactInput {
  files: readonly ChangedFile[]
  /** Each side's map; absent where that side has no tree */
  base?: ConceptMap
  head?: ConceptMap
  changes: SymbolChanges
  /** The tests that reach a set of head node ids */
  testsReaching: (ids: string[]) => TestRef[]
}

const text = (p: ConceptPage): ConceptText => ({ title: p.title, model: p.model, why: p.why })
const sameText = (a: ConceptText, b: ConceptText) => a.title === b.title && a.model === b.model && a.why === b.why

/** Pages grouped by their first two levels below the root (the root alone is its own group) */
const groupOf = (id: string) => id.split('/').slice(0, 2).join('/')

function list(items: string[], max = 3): string {
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} and ${items.length - max} more` : shown
}

/**
 * The one-line skim: "Shifts Agents › Access (2 changed, 1 new); touches Agents › Identity (code only)". Concepts are
 * rolled up to their first two levels; shifted ones (a page added, changed or removed) by how many pages, then those
 * touched in code only by how many symbols.
 */
export function conceptSummary(pages: readonly ConceptTouch[]): string {
  const byId = new Map(pages.map((p) => [p.id, p]))
  const groups = new Map<string, { label: string; added: number; changed: number; removed: number; code: number }>()
  for (const p of pages) {
    const id = groupOf(p.id)
    let g = groups.get(id)
    if (!g) {
      const titles =
        id === ''
          ? [byId.get('')?.title ?? '']
          : id.split('/').map((_, i, s) => byId.get(s.slice(0, i + 1).join('/'))?.title)
      g = { label: titles.filter(Boolean).join(' › '), added: 0, changed: 0, removed: 0, code: 0 }
      groups.set(id, g)
    }
    if (p.page) g[p.page]++
    g.code += p.symbols.added + p.symbols.removed + p.symbols.modified
  }
  const all = [...groups.values()]
  const shifted = all
    .filter((g) => g.added + g.changed + g.removed > 0)
    .sort((a, b) => b.added + b.changed + b.removed - (a.added + a.changed + a.removed) || byCodeUnit(a.label, b.label))
  const touched = all
    .filter((g) => g.added + g.changed + g.removed === 0 && g.code > 0)
    .sort((a, b) => b.code - a.code || byCodeUnit(a.label, b.label))
  const counts = (g: (typeof all)[number]) =>
    [g.changed && `${g.changed} changed`, g.added && `${g.added} new`, g.removed && `${g.removed} removed`]
      .filter(Boolean)
      .join(', ')
  const parts: string[] = []
  if (shifted.length) parts.push(`Shifts ${list(shifted.map((g) => `${g.label} (${counts(g)})`))}`)
  if (touched.length)
    parts.push(`${parts.length ? 'touches' : 'Touches'} ${list(touched.map((g) => g.label))} (code only)`)
  return parts.join('; ')
}

/** What the change does to the concept tree; undefined when neither side has one */
export function conceptImpact(input: ConceptImpactInput): ChangeConcepts | undefined {
  const { base, head, files, changes } = input
  const tree = head?.tree ?? base?.tree
  if (!tree) return undefined
  const pageOn = (id: string) => head?.page(id) ?? base?.page(id)

  // Model shifts: a page file the change touches. A page that leaves one file for another keeps its id: changed.
  const headByFile = new Map(head?.tree.pages.map((p) => [p.file, p]) ?? [])
  const baseByFile = new Map(base?.tree.pages.map((p) => [p.file, p]) ?? [])
  const added = new Set<string>()
  const removed = new Set<string>()
  const edited = new Set<string>()
  for (const f of files) {
    const h = f.status === 'deleted' ? undefined : headByFile.get(f.path)
    const b = f.status === 'added' ? undefined : baseByFile.get(f.oldPath ?? f.path)
    if (h && b && h.id === b.id) edited.add(h.id)
    else {
      if (h) added.add(h.id)
      if (b) removed.add(b.id)
    }
  }
  const shift = new Map<string, NonNullable<ConceptTouch['page']>>()
  for (const id of edited) shift.set(id, 'changed')
  for (const id of added) shift.set(id, removed.has(id) ? 'changed' : 'added')
  for (const id of removed) if (!added.has(id)) shift.set(id, 'removed')

  // Code touches: each changed symbol through its own side's map
  const touches = new Map<string, { symbols: ConceptTouch['symbols']; files: Set<string>; headIds: string[] }>()
  const touch = (page: string | undefined, n: GraphNode, field: keyof ConceptTouch['symbols']) => {
    if (page === undefined) return
    let t = touches.get(page)
    if (!t) touches.set(page, (t = { symbols: { added: 0, removed: 0, modified: 0 }, files: new Set(), headIds: [] }))
    t.symbols[field]++
    t.files.add(n.filePath)
    if (field !== 'removed') t.headIds.push(n.id)
  }
  for (const n of changes.added) touch(head?.pageOf(n), n, 'added')
  for (const p of changes.modified) touch(head?.pageOf(p.head), p.head, 'modified')
  for (const n of changes.removed) touch(base?.pageOf(n), n, 'removed')

  // The touched pages and every ancestor, on whichever side has them
  const shown = new Set<string>()
  for (const id of [...shift.keys(), ...touches.keys()]) {
    for (let at: string | null = id; at !== null && !shown.has(at); at = pageOn(at)?.parent ?? null) shown.add(at)
  }
  if (shown.size === 0) return { dir: tree.dir, summary: '', pages: [] }

  const touchesUnder = (id: string) => [...touches.keys()].some((t) => t === id || isAncestor(id, t))
  const entry = (id: string): ConceptTouch => {
    const p = pageOn(id)!
    const page = shift.get(id)
    const t = touches.get(id)
    const before = page === 'changed' ? base?.page(id) : undefined
    const signal = page ? (touchesUnder(id) ? undefined : 'docs-only') : t ? 'stale-page' : undefined
    return {
      id,
      parent: p.parent,
      depth: p.depth,
      file: p.file,
      ...text(p),
      ...(page ? { page } : {}),
      ...(before && !sameText(text(before), text(p)) ? { before: text(before) } : {}),
      symbols: t?.symbols ?? { added: 0, removed: 0, modified: 0 },
      files: [...(t?.files ?? [])].sort(byCodeUnit),
      tests: t && t.headIds.length > 0 ? input.testsReaching(t.headIds).map((r) => r.id) : [],
      ...(signal ? { signal } : {})
    }
  }

  // Parents first; siblings in head's order, then pages only base has
  const children = (id: string) => [
    ...new Set([...(head?.page(id)?.children ?? []), ...(base?.page(id)?.children ?? [])])
  ]
  const pages: ConceptTouch[] = []
  const visit = (id: string) => {
    if (!shown.has(id)) return
    pages.push(entry(id))
    for (const c of children(id)) visit(c)
  }
  const roots = [...shown].filter((id) => pageOn(id)!.parent === null).sort(byCodeUnit)
  for (const r of roots) visit(r)
  return { dir: tree.dir, summary: conceptSummary(pages), pages }
}
