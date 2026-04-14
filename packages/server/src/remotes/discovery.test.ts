import { describe, expect, it } from 'vitest'
import { orderRemotes, selectPreferredRemote } from './discovery.js'
import type { Remote } from '../issues/types.js'

describe('remote discovery ordering', () => {
  const remotes: Remote[] = [
    { name: 'origin', provider: 'github', repo: 'secondary/repo' },
    { name: 'rad', provider: 'radicle', rid: 'z3gqcJUoA1n9HaHKufZs5FCSGazv5' }
  ]

  it('prefers explicit project remote over provider ordering', () => {
    const ordered = orderRemotes(remotes, { preferredRemoteName: 'origin', preferredProvider: 'radicle' })
    expect(ordered.map((remote) => remote.name)).toEqual(['origin', 'rad'])
  })

  it('prefers canonical provider when no explicit project remote is set', () => {
    const ordered = orderRemotes(remotes, { preferredProvider: 'radicle' })
    expect(ordered.map((remote) => remote.name)).toEqual(['rad', 'origin'])
  })

  it('selects canonical provider remote for default write flows', () => {
    const selected = selectPreferredRemote(remotes, { preferredProvider: 'radicle' })
    expect(selected?.name).toBe('rad')
  })
})
