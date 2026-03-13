import { describe, expect, it } from 'vitest'
import { createEventBus } from './index'

describe('Core', () => {
  it('exports createEventBus', () => {
    expect(typeof createEventBus).toBe('function')
  })
})
