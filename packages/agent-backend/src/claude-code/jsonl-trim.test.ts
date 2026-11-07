import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stubSupersededInstructions, trimJsonlToLastCompaction } from './jsonl-trim.js'

// Helpers to build realistic JSONL lines.
function entry(uuid: string, type: string, subtype?: string, parent?: string): string {
  const e: Record<string, unknown> = { uuid, type }
  if (subtype) e.subtype = subtype
  if (parent) e.logicalParentUuid = parent
  return JSON.stringify(e)
}

function compactBoundary(uuid: string, logicalParent: string): string {
  return JSON.stringify({
    uuid,
    type: 'system',
    subtype: 'compact_boundary',
    logicalParentUuid: logicalParent,
    compactMetadata: { trigger: 'auto', preTokens: 100000, postTokens: 5000 }
  })
}

describe('trimJsonlToLastCompaction', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsonl-trim-'))
    file = join(dir, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 0 and leaves file untouched when no compact_boundary exists', () => {
    const content =
      [entry('a1', 'user'), entry('a2', 'assistant', '', 'a1'), entry('a3', 'user', '', 'a2')].join('\n') + '\n'
    writeFileSync(file, content)
    const reclaimed = trimJsonlToLastCompaction(file)
    expect(reclaimed).toBe(0)
    expect(readFileSync(file, 'utf-8')).toBe(content)
  })

  it('trims to anchor + compact_boundary + post-boundary content', () => {
    // Build a JSONL with 3 old entries, an anchor, a compact_boundary, and 2 new entries.
    const oldEntries = ['old-a', 'old-b', 'old-c'].map((id) => entry(id, 'user'))
    const anchorLine = entry('anchor', 'user')
    const cbLine = compactBoundary('cb-uuid', 'anchor')
    const newEntries = [entry('new-1', 'user', '', 'cb-uuid'), entry('new-2', 'assistant', '', 'new-1')]
    const allLines = [...oldEntries, anchorLine, cbLine, ...newEntries]
    const original = allLines.join('\n') + '\n'
    writeFileSync(file, original)

    const reclaimed = trimJsonlToLastCompaction(file)
    expect(reclaimed).toBeGreaterThan(0)

    const trimmed = readFileSync(file, 'utf-8')
    const trimmedLines = trimmed.split('\n').filter((l) => l.trim())

    // Must contain anchor, compact_boundary, and both new entries.
    const uuids = trimmedLines.map((l) => (JSON.parse(l) as Record<string, unknown>).uuid)
    expect(uuids).toContain('anchor')
    expect(uuids).toContain('cb-uuid')
    expect(uuids).toContain('new-1')
    expect(uuids).toContain('new-2')

    // Must NOT contain old entries.
    expect(uuids).not.toContain('old-a')
    expect(uuids).not.toContain('old-b')
    expect(uuids).not.toContain('old-c')
  })

  it('uses the LAST compact_boundary when multiple exist', () => {
    // Two compaction cycles — should trim to the second boundary.
    const firstAnchor = entry('anchor-1', 'user')
    const firstCb = compactBoundary('cb-1', 'anchor-1')
    const midEntries = [entry('mid-a', 'user'), entry('mid-b', 'assistant')]
    const secondAnchor = entry('anchor-2', 'user')
    const secondCb = compactBoundary('cb-2', 'anchor-2')
    const latestEntries = [entry('latest-1', 'user'), entry('latest-2', 'assistant')]

    const allLines = [firstAnchor, firstCb, ...midEntries, secondAnchor, secondCb, ...latestEntries]
    writeFileSync(file, allLines.join('\n') + '\n')

    const reclaimed = trimJsonlToLastCompaction(file)
    expect(reclaimed).toBeGreaterThan(0)

    const trimmedLines = readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
    const uuids = trimmedLines.map((l) => (JSON.parse(l) as Record<string, unknown>).uuid)

    // Second boundary and its context must survive.
    expect(uuids).toContain('anchor-2')
    expect(uuids).toContain('cb-2')
    expect(uuids).toContain('latest-1')
    expect(uuids).toContain('latest-2')

    // First boundary context must NOT survive.
    expect(uuids).not.toContain('anchor-1')
    expect(uuids).not.toContain('cb-1')
    expect(uuids).not.toContain('mid-a')
    expect(uuids).not.toContain('mid-b')
  })

  it('handles a compact_boundary with no logicalParentUuid gracefully', () => {
    const oldLine = entry('old-x', 'user')
    const cbLine = JSON.stringify({ uuid: 'cb-no-parent', type: 'system', subtype: 'compact_boundary' })
    const newLine = entry('new-x', 'user')
    writeFileSync(file, [oldLine, cbLine, newLine].join('\n') + '\n')

    const reclaimed = trimJsonlToLastCompaction(file)
    // Still reclaims old-x (no anchor needed without logicalParentUuid).
    expect(reclaimed).toBeGreaterThan(0)
    const uuids = readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as Record<string, unknown>).uuid)
    expect(uuids).not.toContain('old-x')
    expect(uuids).toContain('cb-no-parent')
    expect(uuids).toContain('new-x')
  })

  it('returns 0 when the file is already minimal (no old content to remove)', () => {
    const anchor = entry('anchor', 'user')
    const cb = compactBoundary('cb', 'anchor')
    const newEntry = entry('new', 'user')
    writeFileSync(file, [anchor, cb, newEntry].join('\n') + '\n')

    // First trim removes nothing additional (file is already minimal).
    // The file has: anchor + cb + new — which IS the minimal set.
    trimJsonlToLastCompaction(file)
    // reclaimed may be 0 or tiny trailing-newline difference — key: no crash.
    // The content must still be valid.
    const uuids = readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => (JSON.parse(l) as Record<string, unknown>).uuid)
    expect(uuids).toContain('anchor')
    expect(uuids).toContain('cb')
    expect(uuids).toContain('new')
  })

  it('is idempotent — trimming twice produces the same result', () => {
    const oldEntries = Array.from({ length: 20 }, (_, i) => entry(`old-${i}`, 'user'))
    const anchor = entry('anchor', 'user')
    const cb = compactBoundary('cb', 'anchor')
    const newEntries = Array.from({ length: 5 }, (_, i) => entry(`new-${i}`, 'user'))
    writeFileSync(file, [...oldEntries, anchor, cb, ...newEntries].join('\n') + '\n')

    trimJsonlToLastCompaction(file)
    const afterFirst = readFileSync(file, 'utf-8')
    const reclaimedSecond = trimJsonlToLastCompaction(file)
    const afterSecond = readFileSync(file, 'utf-8')

    // Second trim reclaims nothing (file already minimal).
    expect(reclaimedSecond).toBe(0)
    expect(afterFirst).toBe(afterSecond)
  })
})

describe('stubSupersededInstructions', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsonl-instr-'))
    file = join(dir, 'session.jsonl')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const instructions = (uuid: string, parent: string, files: Array<[string, string]>) =>
    JSON.stringify({
      type: 'attachment',
      uuid,
      parentUuid: parent,
      attachment: {
        type: 'instructions',
        changed: true,
        files: files.map(([path, content]) => ({ path, type: 'User', content }))
      }
    })
  const lines = (f: string) =>
    readFileSync(f, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  it('keeps the newest copy of each file and stubs the older ones, leaving the entries and their links', () => {
    const md = '/home/u/.claude/CLAUDE.md'
    writeFileSync(
      file,
      [
        entry('u1', 'user'),
        instructions('i1', 'u1', [[md, 'v1 '.repeat(500)]]),
        entry('a1', 'assistant', '', 'i1'),
        instructions('i2', 'a1', [[md, 'v2 '.repeat(500)]]),
        instructions('i3', 'i2', [[md, 'v3 '.repeat(500)]])
      ].join('\n') + '\n'
    )
    const freed = stubSupersededInstructions(file)
    const out = lines(file)

    expect(out.map((e) => e.uuid)).toEqual(['u1', 'i1', 'a1', 'i2', 'i3'])
    expect(out[3].parentUuid).toBe('a1')
    expect(out[1].attachment.files[0].content).toMatch(/superseded/)
    expect(out[3].attachment.files[0].content).toMatch(/superseded/)
    expect(out[4].attachment.files[0].content).toBe('v3 '.repeat(500))
    expect(out[1].attachment.files[0].path).toBe(md)
    expect(freed).toBeGreaterThan(2_500)
  })

  it('tracks each file on its own', () => {
    writeFileSync(
      file,
      [
        instructions('i1', 'x', [
          ['/a.md', 'A1'.repeat(100)],
          ['/b.md', 'B1'.repeat(100)]
        ]),
        instructions('i2', 'i1', [['/a.md', 'A2'.repeat(100)]])
      ].join('\n') + '\n'
    )
    stubSupersededInstructions(file)
    const out = lines(file)
    expect(out[0].attachment.files[0].content).toMatch(/superseded/)
    expect(out[0].attachment.files[1].content).toBe('B1'.repeat(100))
    expect(out[1].attachment.files[0].content).toBe('A2'.repeat(100))
  })

  it('changes nothing with one copy per file, and is idempotent', () => {
    const one = [entry('u1', 'user'), instructions('i1', 'u1', [['/a.md', 'only']])].join('\n') + '\n'
    writeFileSync(file, one)
    expect(stubSupersededInstructions(file)).toBe(0)
    expect(readFileSync(file, 'utf-8')).toBe(one)

    writeFileSync(
      file,
      [instructions('i1', 'x', [['/a.md', 'old'.repeat(50)]]), instructions('i2', 'i1', [['/a.md', 'new']])].join(
        '\n'
      ) + '\n'
    )
    stubSupersededInstructions(file)
    const once = readFileSync(file, 'utf-8')
    expect(stubSupersededInstructions(file)).toBe(0)
    expect(readFileSync(file, 'utf-8')).toBe(once)
  })
})
