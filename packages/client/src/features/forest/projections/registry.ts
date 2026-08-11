// ── Projection strategy registry ────────────────────────────────────

import type { ProjectionStrategy } from '../types.js'
import { hashProjection } from './hash.js'
import { semanticProjection } from './semantic.js'
import { ontologicalProjection } from './ontological.js'

const STRATEGIES: Record<string, ProjectionStrategy> = {
  hash: hashProjection,
  semantic: semanticProjection,
  ontological: ontologicalProjection
}

export function getStrategy(id: string): ProjectionStrategy | undefined {
  return STRATEGIES[id]
}

export function allStrategies(): ProjectionStrategy[] {
  return Object.values(STRATEGIES)
}
