import { describe, expect, it } from 'vitest'
import { add, SHARED_CONSTANT } from './index'

describe('Core', () => {
  it('adds numbers', () => {
    expect(add(1, 2)).toBe(3)
  })
  it('has shared constant', () => {
    expect(SHARED_CONSTANT).toBe('template')
  })
})
