import { describe, expect, it } from 'vitest'
import { DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from './agent-backend'

describe('reasoning effort', () => {
  it('starts new threads at medium, one of the levels the backend offers', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('medium')
    expect(REASONING_EFFORTS).toContain(DEFAULT_REASONING_EFFORT)
  })
})
