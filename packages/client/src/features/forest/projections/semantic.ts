// ── Semantic projection ─────────────────────────────────────────────
// Projects nodes into a 3D subspace of the high-dimensional embedding
// space. Uses a frozen PCA basis computed once from the initial corpus.
// The user selects which 3 of N principal components to view through.

import type { ProjectionStrategy, ForestNode, ProjectionContext, Vec3 } from '../types.js'

function dot(a: number[], b: number[]): number {
  let sum = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) sum += a[i] * b[i]
  return sum
}

export const semanticProjection: ProjectionStrategy = {
  id: 'semantic',
  label: 'Semantic Space',
  dimensionCount: 10, // default; overridden at runtime from index

  project(node: ForestNode, context: ProjectionContext): Vec3 {
    const { pcaBasis, pcaMean, dimensions } = context
    if (!pcaBasis || !pcaMean || !node.embedding?.length) {
      return { x: 0, y: 0, z: 0 }
    }

    // Center the embedding
    const centered = new Array(node.embedding.length)
    for (let i = 0; i < node.embedding.length; i++) {
      centered[i] = node.embedding[i] - (pcaMean[i] ?? 0)
    }

    // Project onto the selected principal components
    const [d0, d1, d2] = dimensions
    const scale = 10 // spread the space to ±10 units
    return {
      x: pcaBasis[d0] ? dot(centered, pcaBasis[d0]) * scale : 0,
      y: pcaBasis[d1] ? dot(centered, pcaBasis[d1]) * scale : 0,
      z: pcaBasis[d2] ? dot(centered, pcaBasis[d2]) * scale : 0
    }
  },

  axes: {
    x: 'PC 1',
    y: 'PC 2',
    z: 'PC 3'
  }
}
