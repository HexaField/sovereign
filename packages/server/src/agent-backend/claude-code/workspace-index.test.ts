import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceIndex } from './workspace-index.js'

const FENCE_BEGIN = '<!-- BEGIN sovereign-workspaces (managed by Sovereign — do not edit by hand) -->'
const FENCE_END = '<!-- END sovereign-workspaces -->'

describe('claude-code/workspace-index', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sov-ws-'))
    filePath = join(dir, 'CLAUDE.md')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a Sovereign fence into an empty file', () => {
    const idx = createWorkspaceIndex({ filePath, debounceMs: 0 })
    idx.setEntries([{ path: '/Users/josh/foo', description: 'foo workspace', orgId: 'foo' }])
    idx.flush()
    idx.dispose()

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain(FENCE_BEGIN)
    expect(content).toContain(FENCE_END)
    expect(content).toContain('`/Users/josh/foo`')
    expect(content).toContain('foo workspace')
    expect(content).toContain('(org: foo)')
  })

  it('preserves user content outside the fence', () => {
    writeFileSync(filePath, '# My personal CLAUDE.md\n\nUser content above.\n')
    const idx = createWorkspaceIndex({ filePath, debounceMs: 0 })
    idx.setEntries([{ path: '/a' }, { path: '/b', description: 'b ws' }])
    idx.flush()
    idx.dispose()

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('# My personal CLAUDE.md')
    expect(content).toContain('User content above.')
    expect(content).toContain(FENCE_BEGIN)
    expect(content).toContain('`/a`')
    expect(content).toContain('`/b`')
  })

  it('updates only the fenced block on subsequent calls', () => {
    writeFileSync(filePath, `Hello.\n\n${FENCE_BEGIN}\nold workspaces\n${FENCE_END}\n\nGoodbye.\n`)
    const idx = createWorkspaceIndex({ filePath, debounceMs: 0 })
    idx.setEntries([{ path: '/new' }])
    idx.flush()
    idx.dispose()

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toContain('Hello.')
    expect(content).toContain('Goodbye.')
    expect(content).toContain('`/new`')
    expect(content).not.toContain('old workspaces')
  })

  it('no-ops when the entries are unchanged', () => {
    const idx = createWorkspaceIndex({ filePath, debounceMs: 0 })
    idx.setEntries([{ path: '/a' }])
    idx.flush()
    const initial = readFileSync(filePath, 'utf-8')

    idx.setEntries([{ path: '/a' }])
    idx.flush()
    idx.dispose()

    expect(readFileSync(filePath, 'utf-8')).toBe(initial)
  })
})
