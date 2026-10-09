import { describe, it, expect } from 'vitest'
import { pageTitle } from './page-title.js'

describe('pageTitle', () => {
  it('puts the thread name before Sovereign', () => {
    expect(pageTitle('adam')).toBe('adam · Sovereign')
  })

  it('falls back to Sovereign without a named thread', () => {
    expect(pageTitle(undefined)).toBe('Sovereign')
    expect(pageTitle(null)).toBe('Sovereign')
    expect(pageTitle('  ')).toBe('Sovereign')
  })
})
