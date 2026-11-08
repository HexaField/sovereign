// What the Structure section and the reach badge show, as plain functions.

import type { WorkNodeStructure } from '@sovereign/core/forge'
import type { ChangeStructure, ModuleTouch, SymbolRef, TestRef } from '@sovereign/graphcoder-core/contract'

export interface Badge {
  text: string
  title: string
  tone: 'normal' | 'muted' | 'error'
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "reach 8 in 2 parts", or the plain "reach 8" for one part */
export function reachText(reach: number, parts: number): string {
  return parts > 1 ? `reach ${reach} in ${parts} parts` : `reach ${reach}`
}

/** The Kanban card's badge for a change's structure; null when the node has none */
export function reachBadge(s: WorkNodeStructure | undefined): Badge | null {
  if (!s) return null
  if (s.state === 'computing')
    return { text: 'reach …', title: 'Computing the structure of this change', tone: 'muted' }
  if (s.state === 'failed') return { text: 'reach ?', title: `No structure: ${s.error ?? 'failed'}`, tone: 'error' }
  const counts = [
    plural(s.modules ?? 0, 'module'),
    plural(s.symbols ?? 0, 'symbol'),
    plural(s.tests ?? 0, 'test')
  ].join(' · ')
  return {
    text: `reach ${s.reach ?? 0}`,
    title: `${reachText(s.reach ?? 0, s.parts ?? 1)}: the most hops between two changed symbols · ${counts}${s.concepts ? `\n${s.concepts}` : ''}`,
    tone: 'normal'
  }
}

export interface SymbolGroup {
  key: 'added' | 'modified' | 'removed'
  label: string
  sign: string
  items: SymbolRef[]
}

/** Added, modified, removed, in that order */
export function symbolGroups(s: ChangeStructure): SymbolGroup[] {
  return [
    { key: 'added', label: 'Added', sign: '+', items: s.symbols.added },
    { key: 'modified', label: 'Modified', sign: '~', items: s.symbols.modified },
    { key: 'removed', label: 'Removed', sign: '−', items: s.symbols.removed }
  ]
}

/** "+3 ~2 −1", leaving out zeros */
export function moduleCounts(m: ModuleTouch): string {
  return [m.added ? `+${m.added}` : '', m.modified ? `~${m.modified}` : '', m.removed ? `−${m.removed}` : '']
    .filter(Boolean)
    .join(' ')
}

/** A test as a card lists it: its name (the file for a file-level test), its file, how far it is from the change */
export function testLabel(t: TestRef): { name: string; file: string; depth: string } {
  const prefix = `${t.file}::`
  return {
    name: t.id.startsWith(prefix) ? t.id.slice(prefix.length) : t.file.split('/').pop()!,
    file: t.file,
    depth: t.depth === 0 ? 'edited' : t.depth === 1 ? 'calls it' : `${t.depth} hops`
  }
}
