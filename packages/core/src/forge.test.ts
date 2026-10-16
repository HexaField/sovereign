import { describe, it, expect } from 'vitest'
import { parseRefKey, refKey, type ForgeRef } from './forge.js'

describe('refKey', () => {
  it('writes changes and issues with "#" and branches with "@", and reads them back', () => {
    const pr: ForgeRef = { forge: 'github', host: 'github.com', repo: 'org/repo', kind: 'change', id: '12' }
    const branch: ForgeRef = { forge: 'github', host: 'github.com', repo: 'org/repo', kind: 'branch', id: 'feat/a#b' }
    expect(refKey(pr)).toBe('github:github.com/org/repo#12')
    expect(refKey(branch)).toBe('github:github.com/org/repo@feat/a#b')
    expect(parseRefKey(refKey(pr), 'change')).toEqual(pr)
    expect(parseRefKey(refKey(branch), 'branch')).toEqual(branch)
    expect(parseRefKey('nonsense', 'issue')).toBeUndefined()
  })
})
