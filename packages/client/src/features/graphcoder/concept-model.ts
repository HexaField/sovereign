// What the concept views show, as plain functions: the concept map of a
// checkout (P2) and the concept impact of a change (P1b).

import type {
  ChangeStructure,
  ConceptCoverage,
  ConceptMapReport,
  ConceptNode,
  ConceptTouch,
  SharedClaim,
  TestRef
} from '@sovereign/graphcoder-core/contract'
import { symbolGroups, type SymbolGroup } from './structure-model.js'

// ── Concept map ──────────────────────────────────────────────────────────────

/** "1,220 of 1,229 files (99.3 %)" */
export function coverageText(c: ConceptCoverage): string {
  const pct = c.files === 0 ? 0 : (100 * c.covered) / c.files
  return `${c.covered.toLocaleString('en')} of ${c.files.toLocaleString('en')} files (${pct.toFixed(1)} %)`
}

export interface PageChecks {
  stale: string[]
  shared: SharedClaim[]
  unresolved: string[]
}

/** Each page's findings: its stale links, the shared claims it is part of, its names that resolve to nothing */
export function pageChecks(report: ConceptMapReport): Map<string, PageChecks> {
  const out = new Map<string, PageChecks>(
    report.pages.map((p) => [p.id, { stale: [], shared: [], unresolved: p.unresolved }])
  )
  for (const s of report.stale) out.get(s.page)?.stale.push(s.path)
  for (const s of report.shared) for (const page of s.pages) out.get(page)?.shared.push(s)
  return out
}

/** "1 stale · 2 shared · 3 unresolved", leaving out zeros */
export function checkText(c: PageChecks | undefined): string {
  if (!c) return ''
  return [
    c.stale.length && `${c.stale.length} stale`,
    c.shared.length && `${c.shared.length} shared`,
    c.unresolved.length && `${c.unresolved.length} unresolved`
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Files each page owns together with the pages below it */
export function subtreeFiles(report: ConceptMapReport): Map<string, number> {
  const byId = new Map(report.pages.map((p) => [p.id, p]))
  const out = new Map<string, number>()
  const total = (p: ConceptNode): number => {
    const held = out.get(p.id)
    if (held !== undefined) return held
    const sum = p.files + p.children.reduce((a, c) => a + (byId.has(c) ? total(byId.get(c)!) : 0), 0)
    out.set(p.id, sum)
    return sum
  }
  for (const p of report.pages) total(p)
  return out
}

/** The pages a page's code depends on, most edges first */
export function usesOf(
  report: ConceptMapReport,
  id: string,
  max = 5
): Array<{ id: string; title: string; edges: number }> {
  const titles = new Map(report.pages.map((p) => [p.id, p.title]))
  return report.dependencies
    .filter((d) => d.from === id)
    .slice(0, max)
    .map((d) => ({ id: d.to, title: titles.get(d.to) ?? d.to, edges: d.edges }))
}

// ── Concept impact ───────────────────────────────────────────────────────────

export interface Marker {
  /** Short label: what happened to the concept */
  text: 'new' | 'changed' | 'removed' | 'code' | ''
  title: string
}

/** What the change does to one concept: its page added / changed / removed, or code under it only */
export function conceptMarker(t: ConceptTouch): Marker {
  if (t.page === 'added') return { text: 'new', title: 'The change adds this page' }
  if (t.page === 'changed') return { text: 'changed', title: 'The change edits this page' }
  if (t.page === 'removed') return { text: 'removed', title: 'The change removes this page' }
  const n = t.symbols.added + t.symbols.removed + t.symbols.modified
  return n > 0 ? { text: 'code', title: 'Code under this page changes; the page does not' } : { text: '', title: '' }
}

/** The scripted signal in words */
export function signalText(t: ConceptTouch): string {
  if (t.signal === 'stale-page') return 'stale page?'
  if (t.signal === 'docs-only') return 'docs only'
  return ''
}

/** "+1 ~2 −1", leaving out zeros */
export function touchCounts(t: ConceptTouch): string {
  const { added, modified, removed } = t.symbols
  return [added ? `+${added}` : '', modified ? `~${modified}` : '', removed ? `−${removed}` : '']
    .filter(Boolean)
    .join(' ')
}

/** A concept's changed symbols, the tests that reach them (nearest first) and its files: the master depth */
export function conceptDetail(
  s: ChangeStructure,
  t: ConceptTouch
): { symbols: SymbolGroup[]; tests: TestRef[]; files: string[] } {
  const own = (refs: ChangeStructure['symbols']['added']) => refs.filter((r) => r.concept === t.id)
  const groups = symbolGroups({
    ...s,
    symbols: { added: own(s.symbols.added), removed: own(s.symbols.removed), modified: own(s.symbols.modified) }
  }).filter((g) => g.items.length > 0)
  const ids = new Set(t.tests)
  return { symbols: groups, tests: s.tests.filter((r) => ids.has(r.id)), files: t.files }
}
