// ── Easing functions for projection transitions ────────────────────

import type { EasingId } from './types.js'

export function applyEasing(t: number, id: EasingId): number {
  switch (id) {
    case 'linear':
      return t
    case 'easeOut':
      return 1 - (1 - t) * (1 - t)
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2
    case 'spring': {
      // Damped spring — slight overshoot then settle
      const w = 8 // angular frequency
      const d = 0.6 // damping
      return 1 - Math.exp(-d * w * t) * Math.cos(w * Math.sqrt(1 - d * d) * t)
    }
    default:
      return t
  }
}
