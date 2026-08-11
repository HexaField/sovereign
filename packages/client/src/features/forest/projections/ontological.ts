// ── Ontological projection ──────────────────────────────────────────
// Positions nodes along human-labelled axes:
//   x — domain (entity type, spread deterministically)
//   y — abstraction level (concept/system high, person/place low)
//   z — temporal (timestamp, oldest→newest)
//
// Deterministic: same node always → same position.

import type { ProjectionStrategy, ForestNode, ProjectionContext, Vec3 } from '../types.js'

/** FNV-1a 32-bit hash (same as hash.ts) */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Abstraction score by entity type (0 = concrete, 10 = abstract) */
const ABSTRACTION: Record<string, number> = {
  person: 1,
  place: 2,
  event: 3,
  organization: 4,
  tool: 5,
  project: 6,
  system: 7,
  concept: 9,
  note: 5 // varies, middle ground
}

function abstractionScore(entityType: string): number {
  return ABSTRACTION[entityType.toLowerCase()] ?? 5
}

export const ontologicalProjection: ProjectionStrategy = {
  id: 'ontological',
  label: 'Ontological Grid',

  project(node: ForestNode, context: ProjectionContext): Vec3 {
    // x: domain — deterministic spread by entity type + IRI
    const typeHash = fnv1a(node.entityType + ':' + node.iri)
    const domainX = (typeHash % 2000) / 100 - 10

    // y: abstraction level — scaled to ±10
    const abs = abstractionScore(node.entityType)
    const domainY = (abs / 10) * 20 - 10

    // z: temporal — normalised across all nodes in the index
    let domainZ = 0
    if (context.allNodes.length > 1) {
      let minTs = Infinity
      let maxTs = -Infinity
      for (const n of context.allNodes) {
        if (n.timestamp < minTs) minTs = n.timestamp
        if (n.timestamp > maxTs) maxTs = n.timestamp
      }
      const range = maxTs - minTs || 1
      domainZ = ((node.timestamp - minTs) / range) * 20 - 10
    }

    return { x: domainX, y: domainY, z: domainZ }
  },

  axes: {
    x: 'Domain',
    y: 'Abstraction',
    z: 'Time'
  }
}
