import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createFileListCache, listFiles, scorePath, searchFiles } from './file-search.js'

const FILES = [
  'packages/client/src/features/chat/ChatView.tsx',
  'packages/client/src/features/chat/ChatView.test.ts',
  'packages/files/src/routes.ts',
  'packages/files/src/file-search.ts',
  'packages/server/src/bootstrap.ts',
  'AGENTS.md',
  'plans/archive/agents-old.md',
  'docs/routing.md'
]

describe('scorePath', () => {
  it('matches characters in order, case-insensitively, and reports their positions', () => {
    const m = scorePath('cv', 'src/ChatView.tsx')!
    expect(m).not.toBeNull()
    expect(m.positions.map((i) => 'src/ChatView.tsx'[i]).join('')).toBe('CV')
    expect(scorePath('vc', 'src/ChatView.tsx')).toBeNull()
    expect(scorePath('xyz', 'src/ChatView.tsx')).toBeNull()
  })

  it('prefers a match in the file name over one spread across directories', () => {
    const inName = scorePath('route', 'packages/files/src/routes.ts')!
    const inDirs = scorePath('route', 'packages/r/o/u/t/e/x.ts')!
    expect(inName.score).toBeGreaterThan(inDirs.score)
    expect(inName.positions[0]).toBe('packages/files/src/'.length)
  })

  it('matches across the path when the query has a slash', () => {
    const m = scorePath('files/routes', 'packages/files/src/routes.ts')!
    expect(m).not.toBeNull()
    expect(scorePath('chat/routes', 'packages/files/src/routes.ts')).toBeNull()
  })

  it('ignores spaces in the query and matches everything on an empty query', () => {
    expect(scorePath('chat view', 'ChatView.tsx')).not.toBeNull()
    expect(scorePath('', 'any/file.ts')).toEqual({ path: 'any/file.ts', score: 0, positions: [] })
  })
})

describe('searchFiles', () => {
  it('ranks the exact file name first and the test file after the source', () => {
    expect(searchFiles(FILES, 'chatview').matches.map((m) => m.path)).toEqual([
      'packages/client/src/features/chat/ChatView.tsx',
      'packages/client/src/features/chat/ChatView.test.ts'
    ])
    expect(searchFiles(FILES, 'agents').matches[0].path).toBe('AGENTS.md')
    expect(searchFiles(FILES, 'routes.ts').matches[0].path).toBe('packages/files/src/routes.ts')
  })

  it('caps the results and reports the full match count', () => {
    const r = searchFiles(FILES, 's', 3)
    expect(r.matches).toHaveLength(3)
    expect(r.total).toBe(FILES.length)
  })
})

describe('listFiles', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-search-'))
    fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true })
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, 'src/deep/a.ts'), '')
    fs.writeFileSync(path.join(root, 'README.md'), '')
    fs.writeFileSync(path.join(root, '.env.example'), '')
    fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), '')
    fs.writeFileSync(path.join(root, '.git/HEAD'), '')
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('lists files relative to the root, with hidden files but without .git or ignored dirs', async () => {
    const { files, truncated } = await listFiles(root)
    expect(truncated).toBe(false)
    expect(files.sort()).toEqual(['.env.example', '.gitignore', 'README.md', 'src/deep/a.ts'])
  })
})

describe('createFileListCache', () => {
  it('lists once, serves the cached list, and refreshes a stale one in the background', async () => {
    let calls = 0
    const cache = createFileListCache({
      ttlMs: 0,
      list: async () => ({ files: [`v${++calls}`], truncated: false })
    })
    expect((await cache.get('/r')).files).toEqual(['v1'])
    await new Promise((r) => setTimeout(r, 2))
    // Stale: the old list comes back at once while v2 builds.
    expect((await cache.get('/r')).files).toEqual(['v1'])
    await new Promise((r) => setTimeout(r, 0))
    expect((await cache.get('/r')).files).toEqual(['v2'])
  })

  it('shares one in-flight listing between concurrent callers and retries after a failure', async () => {
    let calls = 0
    let fail = true
    const cache = createFileListCache({
      list: async () => {
        calls++
        if (fail) throw new Error('boom')
        return { files: ['x'], truncated: false }
      }
    })
    await expect(Promise.all([cache.get('/r'), cache.get('/r')])).rejects.toThrow('boom')
    expect(calls).toBe(1)
    fail = false
    expect((await cache.get('/r')).files).toEqual(['x'])
  })
})
