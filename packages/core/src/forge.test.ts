import { describe, it, expect } from 'vitest'
import { parseRefKey, refKey, trustedAuthorsOf, type ForgeRef } from './forge.js'

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

describe('trustedAuthorsOf', () => {
  const map = { acme: ['Alex-Dev', 'sam-reporter'], '*': ['kit-ops'] }

  it('takes the membrane\'s list, else "*", else none', () => {
    expect(trustedAuthorsOf(map, 'acme')).toMatchObject({ source: 'membrane', logins: ['Alex-Dev', 'sam-reporter'] })
    expect(trustedAuthorsOf(map, 'other')).toMatchObject({ source: '*', logins: ['kit-ops'] })
    expect(trustedAuthorsOf(map, null)).toMatchObject({ source: '*', logins: ['kit-ops'] })
    expect(trustedAuthorsOf({ acme: ['alex-dev'] }, 'other')).toBeUndefined()
    expect(trustedAuthorsOf({}, 'acme')).toBeUndefined()
    expect(trustedAuthorsOf(undefined, 'acme')).toBeUndefined()
  })

  it('compares logins case-insensitively; an empty list trusts nobody', () => {
    const list = trustedAuthorsOf(map, 'acme')!
    expect(list.has('alex-dev')).toBe(true)
    expect(list.has('ALEX-DEV')).toBe(true)
    expect(list.has('Sam-Reporter')).toBe(true)
    expect(list.has('kit-ops')).toBe(false)
    expect(list.has('')).toBe(false)
    expect(trustedAuthorsOf({ acme: [] }, 'acme')!.has('alex-dev')).toBe(false)
  })
})
