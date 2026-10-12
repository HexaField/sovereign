// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { highlightSegments, openFileFromQuickOpen, pickRoot, quickOpenOpen, setQuickOpenOpen } from './FileQuickOpen.js'

const roots = [
  { id: '_global', name: 'Global', path: '/home/u/.sovereign' },
  { id: 'org-1', name: 'Org', path: '/home/u/workspaces/org' }
]

describe('pickRoot', () => {
  it('picks the active workspace root, else the global root, else the first', () => {
    expect(pickRoot(roots, 'org-1')?.id).toBe('org-1')
    expect(pickRoot(roots, 'unknown')?.id).toBe('_global')
    expect(pickRoot(roots, undefined)?.id).toBe('_global')
    expect(pickRoot([roots[1]], undefined)?.id).toBe('org-1')
    expect(pickRoot([], 'org-1')).toBeUndefined()
  })
})

describe('highlightSegments', () => {
  it('groups matched and unmatched characters into runs', () => {
    expect(highlightSegments('ChatView.tsx', [0, 4, 5])).toEqual([
      { text: 'C', hit: true },
      { text: 'hat', hit: false },
      { text: 'Vi', hit: true },
      { text: 'ew.tsx', hit: false }
    ])
  })

  it('applies an offset so file-name positions index into the full path', () => {
    // positions 4 and 5 of "src/ab" are the file name "ab".
    expect(highlightSegments('ab', [4, 5], 4)).toEqual([{ text: 'ab', hit: true }])
    expect(highlightSegments('src', [4, 5], 0)).toEqual([{ text: 'src', hit: false }])
  })
})

describe('openFileFromQuickOpen', () => {
  it('closes the palette and asks the app to open the file', () => {
    const seen = vi.fn()
    window.addEventListener('sovereign:open-file', (e) => seen((e as CustomEvent).detail))
    setQuickOpenOpen(true)
    openFileFromQuickOpen('/home/u/workspaces/org/a.ts')
    expect(quickOpenOpen()).toBe(false)
    expect(seen).toHaveBeenCalledWith({ path: '/home/u/workspaces/org/a.ts' })
  })
})
