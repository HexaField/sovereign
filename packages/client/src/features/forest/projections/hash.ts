// ── Hash projection ─────────────────────────────────────────────────
// Deterministic spatial hash from the node IRI. Maximum stability,
// zero semantic meaning. Each node always lands at the same position
// regardless of what else exists in the graph.

import type { ProjectionStrategy, ForestNode, Vec3 } from '../types.js'

/** FNV-1a 32-bit hash */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function hashToFloat(hash: number, range: number): number {
  return (hash % (range * 200)) / 100 - range
}

export const hashProjection: ProjectionStrategy = {
  id: 'hash',
  label: 'Spatial Hash',

  project(node: ForestNode): Vec3 {
    const h1 = fnv1a(node.iri + ':x')
    const h2 = fnv1a(node.iri + ':y')
    const h3 = fnv1a(node.iri + ':z')
    return {
      x: hashToFloat(h1, 10),
      y: hashToFloat(h2, 10),
      z: hashToFloat(h3, 10)
    }
  }
}
