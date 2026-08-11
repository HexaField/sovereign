// ── Color palettes for forest visualisation ─────────────────────────

/** Entity-type → hex colour (Three.js integer format) */
export const TYPE_COLORS: Record<string, number> = {
  person: 0x4fc3f7,
  project: 0x81c784,
  concept: 0xba68c8,
  tool: 0xffa726,
  system: 0xef5350,
  place: 0x8d6e63,
  organization: 0x26c6da,
  event: 0xffd54f,
  note: 0x90a4ae
}

const FALLBACK_COLOR = 0xb0bec5

export function colorForType(entityType: string): number {
  return TYPE_COLORS[entityType.toLowerCase()] ?? FALLBACK_COLOR
}

/** Predicate → hex colour */
export const PREDICATE_COLORS: Record<string, number> = {
  'hex://related_to': 0x78909c,
  'hex://part_of': 0x4db6ac,
  'hex://depends_on': 0xf06292,
  'hex://works_on': 0x64b5f6,
  'hex://built_with': 0xffb74d,
  'hex://supersedes': 0xe57373,
  'hex://caused_by': 0xdce775,
  'hex://about': 0xce93d8
}

const FALLBACK_LINK_COLOR = 0x607d8b

export function colorForPredicate(predicate: string): number {
  return PREDICATE_COLORS[predicate] ?? FALLBACK_LINK_COLOR
}

/** Age-based colour: recent → bright, old → dim */
export function colorForAge(timestamp: number, minTs: number, maxTs: number): number {
  const range = maxTs - minTs || 1
  const t = (timestamp - minTs) / range // 0 = oldest, 1 = newest
  const r = Math.round(100 + t * 155)
  const g = Math.round(150 + t * 105)
  const b = Math.round(200 + t * 55)
  return (r << 16) | (g << 8) | b
}
