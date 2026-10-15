// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  clampIndex,
  createFileSearcher,
  highlightSegments,
  loadRoots,
  openFileFromQuickOpen,
  pickRoot,
  quickOpenOpen,
  setQuickOpenOpen,
  type SearchOutcome
} from './FileQuickOpen.js'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('clampIndex', () => {
  it('keeps the selection inside a list that shrank, and at 0 for an empty one', () => {
    expect(clampIndex(7, 3)).toBe(2)
    expect(clampIndex(-1, 3)).toBe(0)
    // ArrowDown on an empty list used to leave -1, so Enter on the results that followed opened nothing.
    expect(clampIndex(0 + 1, 0)).toBe(0)
    expect(clampIndex(1, 5)).toBe(1)
  })
})

describe('createFileSearcher', () => {
  it('applies only the newest search, and nothing after cancel()', async () => {
    const pending: Array<(r: Response) => void> = []
    const seen: SearchOutcome[] = []
    const s = createFileSearcher(
      (o) => seen.push(o),
      (() => new Promise<Response>((resolve) => pending.push(resolve))) as typeof fetch
    )
    const first = s.run('org', 'a')
    const second = s.run('org', 'ab')
    pending[1](json({ results: [{ path: '/x/ab', rel: 'ab', positions: [0, 1] }], total: 1 }))
    pending[0](json({ results: [{ path: '/x/a', rel: 'a', positions: [0] }], total: 9 }))
    await Promise.all([first, second])
    expect(seen).toEqual([{ results: [{ path: '/x/ab', rel: 'ab', positions: [0, 1] }], total: 1 }])

    const third = s.run('org', 'abc')
    s.cancel()
    pending[2](json({ results: [], total: 0 }))
    await third
    expect(seen).toHaveLength(1)
  })

  it('reports the server error, or the status when the body is not JSON', async () => {
    const seen: SearchOutcome[] = []
    const s = createFileSearcher((o) => seen.push(o), (async () => json({ error: 'bad root' }, 400)) as typeof fetch)
    await s.run('x', 'q')
    const t = createFileSearcher(
      (o) => seen.push(o),
      (async () => new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch
    )
    await t.run('x', 'q')
    expect(seen).toEqual([{ error: 'bad root' }, { error: 'search: 502' }])
  })
})

describe('loadRoots', () => {
  it('fetches on every call, so new orgs show up, and falls back to the last list on failure', async () => {
    const realFetch = globalThis.fetch
    let roots = [{ id: '_global', name: 'Global', path: '/g' }]
    let fail = false
    globalThis.fetch = vi.fn(async () => (fail ? json({}, 500) : json({ roots }))) as unknown as typeof fetch
    try {
      expect(await loadRoots()).toEqual(roots)
      roots = [...roots, { id: 'org-2', name: 'New', path: '/n' }]
      expect((await loadRoots()).map((r) => r.id)).toEqual(['_global', 'org-2'])
      fail = true
      expect((await loadRoots()).map((r) => r.id)).toEqual(['_global', 'org-2'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

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
