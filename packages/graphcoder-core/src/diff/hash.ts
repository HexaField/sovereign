import type { GraphSnapshot } from '../graph.js'
import { nodeSemanticId } from '../identity.js'
import { sha256Hex } from '../sha256.js'
import type { ArchDiff } from './types.js'

/** JSON with sorted keys, no whitespace and NFC-normalised strings: equal values give equal text. */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'))
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
  const record = value as Record<string, unknown>
  const pairs = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalJson(record[k])}`)
  return `{${pairs.join(',')}}`
}

/**
 * Content hash of a snapshot's structure: nodes by semantic id with the fields a diff tracks, edges by triple.
 * CodeGraph ids, line numbers and timestamps stay out, so re-indexing unchanged code hashes the same.
 */
export function snapshotHash(snapshot: GraphSnapshot): string {
  const semOf = new Map(snapshot.nodes.map((n) => [n.id, nodeSemanticId(n)]))
  const nodes = snapshot.nodes
    .map((n) => [semOf.get(n.id)!, n] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, n]) => ({
      kind: n.kind,
      name: n.name,
      qualifiedName: n.qualifiedName,
      filePath: n.filePath,
      language: n.language,
      signature: n.signature,
      visibility: n.visibility,
      isExported: n.isExported,
      isAsync: n.isAsync,
      isStatic: n.isStatic,
      isAbstract: n.isAbstract,
      returnType: n.returnType
    }))
  const edges = [
    ...new Set(
      snapshot.edges.flatMap((e) => {
        const source = semOf.get(e.source)
        const target = semOf.get(e.target)
        return source && target ? [`${source}|${target}|${e.kind}`] : []
      })
    )
  ].sort()
  return sha256Hex(canonicalJson({ nodes, edges }))
}

export function computeDiffHash(diff: Omit<ArchDiff, 'diffHash'>): string {
  return sha256Hex(canonicalJson(diff))
}
