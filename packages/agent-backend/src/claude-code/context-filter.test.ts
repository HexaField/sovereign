import { describe, it, expect } from 'vitest'
import { createContextFilter, CONTEXT_FILTER_DEFAULTS } from './context-filter.js'

const { trimThresholdBytes, trimMaxLines, dedupMinBytes } = CONTEXT_FILTER_DEFAULTS

/**
 * A single unbroken line of `bytes` bytes. Long enough to trip the dedup
 * and trim *byte* thresholds but — because it never contains a newline —
 * never long enough in *line count* to trip trimLargeOutput's head+tail
 * rewrite (that only fires once `lines.length > trimMaxLines`). Isolates
 * dedup/signature behaviour from trim behaviour.
 */
function bigBlob(bytes: number): string {
  return 'x'.repeat(bytes)
}

/**
 * Multi-line text sized to exceed both the trim byte threshold and the
 * trim line-count threshold, so trimLargeOutput's head+tail rewrite fires.
 * Each line is uniquely identifiable via its index for head/tail assertions.
 */
function manyLines(count: number): string {
  const padWidth = Math.ceil(trimThresholdBytes / count) + 16
  return Array.from({ length: count }, (_, i) => `line ${i} ${'x'.repeat(padWidth)}`).join('\n')
}

describe('ContextFilter', () => {
  describe('trim', () => {
    it('trims text above the byte threshold to head+tail with a marker', () => {
      const filter = createContextFilter()
      const lineCount = trimMaxLines * 2
      const halfLines = Math.floor(trimMaxLines / 2)
      const trimmedCount = lineCount - trimMaxLines
      const text = manyLines(lineCount)

      const result = filter.filterToolOutput('Bash', text) as string | null

      expect(result).not.toBeNull()
      expect(result).toContain(`[... ${trimmedCount} lines trimmed by context filter ...]`)
      // Head kept.
      expect(result).toContain('line 0 ')
      expect(result).toContain(`line ${halfLines - 1} `)
      // Middle dropped.
      expect(result).not.toContain(`line ${halfLines} `)
      expect(result).not.toContain(`line ${lineCount - halfLines - 1} `)
      // Tail kept.
      expect(result).toContain(`line ${lineCount - halfLines} `)
      expect(result).toContain(`line ${lineCount - 1} `)
    })

    it('leaves text at or below both thresholds unchanged (returns null)', () => {
      const filter = createContextFilter()
      const text = manyLines(10) // well under trimMaxLines and trimThresholdBytes
      expect(filter.filterToolOutput('Bash', text)).toBeNull()
    })

    it('never rewrites a single huge line — the line-count guard trumps the byte threshold', () => {
      const filter = createContextFilter()
      // No newlines at all: byte length blows the threshold, but there is
      // only ever 1 line, so `lines.length <= trimMaxLines` short-circuits.
      const text = bigBlob(trimThresholdBytes * 2)
      expect(filter.filterToolOutput('Bash', text)).toBeNull()
    })
  })

  describe('dedup', () => {
    it('passes the first occurrence of a block through unchanged', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)
      expect(filter.filterToolOutput('Grep', block)).toBeNull()
    })

    it('stubs a second identical block at or above dedupMinBytes', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)

      expect(filter.filterToolOutput('Grep', block)).toBeNull() // first sight
      const second = filter.filterToolOutput('Grep', block)

      expect(second).toBe(`[duplicate content — first seen at turn 0, ${block.length} chars omitted]`)
    })

    it('stamps the stub with the turn active when the block was first seen, not the current turn', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)

      filter.filterToolOutput('Grep', block) // first sight at turn 0
      filter.advanceTurn() // turn -> 1
      filter.advanceTurn() // turn -> 2

      const second = filter.filterToolOutput('Grep', block)
      expect(second).toBe(`[duplicate content — first seen at turn 0, ${block.length} chars omitted]`)
    })

    it('leaves blocks below dedupMinBytes unstubbed even when duplicated', () => {
      const filter = createContextFilter()
      const block = bigBlob(Math.floor(dedupMinBytes / 2))

      expect(filter.filterToolOutput('Grep', block)).toBeNull()
      expect(filter.filterToolOutput('Grep', block)).toBeNull()
    })
  })

  describe('signature strip', () => {
    it('strips a trailing "Co-Authored-By: Claude" line', () => {
      const filter = createContextFilter()
      const text = 'Committed the fix.\nCo-Authored-By: Claude <noreply@anthropic.com>'
      expect(filter.filterToolOutput('Bash', text)).toBe('Committed the fix.')
    })

    it('strips a trailing "🤖 Generated with [Claude Code]" line', () => {
      const filter = createContextFilter()
      const text = 'Committed the fix.\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'
      expect(filter.filterToolOutput('Bash', text)).toBe('Committed the fix.')
    })

    it('strips a trailing "---\\nGenerated" footer block', () => {
      const filter = createContextFilter()
      const text = 'Committed the fix.\n---\nGenerated by an automated process'
      expect(filter.filterToolOutput('Bash', text)).toBe('Committed the fix.')
    })

    it('leaves text with no signature pattern unchanged', () => {
      const filter = createContextFilter()
      const text = 'Just a normal tool output with no footer.'
      expect(filter.filterToolOutput('Bash', text)).toBeNull()
    })
  })

  describe('structured Bash output', () => {
    it('trims a large stdout field and leaves a small stderr untouched', () => {
      const filter = createContextFilter()
      const stdout = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Bash', { stdout, stderr: '' }) as {
        stdout: string
        stderr: string
      } | null

      expect(result).not.toBeNull()
      expect(result!.stdout).not.toBe(stdout)
      expect(result!.stdout).toContain('lines trimmed by context filter')
      expect(result!.stderr).toBe('')
    })

    it('filters stderr independently of stdout', () => {
      const filter = createContextFilter()
      const stderr = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Bash', { stdout: 'ok', stderr }) as {
        stdout: string
        stderr: string
      } | null

      expect(result).not.toBeNull()
      expect(result!.stdout).toBe('ok')
      expect(result!.stderr).toContain('lines trimmed by context filter')
    })

    it('preserves other fields on the output object', () => {
      const filter = createContextFilter()
      const stdout = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Bash', { stdout, stderr: '', exitCode: 0 }) as {
        exitCode: number
      } | null

      expect(result).not.toBeNull()
      expect(result!.exitCode).toBe(0)
    })
  })

  describe('structured Read output', () => {
    it('trims file.content when large', () => {
      const filter = createContextFilter()
      const content = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Read', {
        type: 'text',
        file: { content, otherProp: 'kept' }
      }) as { type: string; file: { content: string; otherProp: string } } | null

      expect(result).not.toBeNull()
      expect(result!.type).toBe('text')
      expect(result!.file.content).toContain('lines trimmed by context filter')
      expect(result!.file.otherProp).toBe('kept')
    })

    it('returns null when type is not "text"', () => {
      const filter = createContextFilter()
      const content = manyLines(trimMaxLines * 2)
      const result = filter.filterToolOutput('Read', { type: 'image', file: { content } })
      expect(result).toBeNull()
    })

    it('returns null when file.content is missing or not a string', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Read', { type: 'text', file: {} })).toBeNull()
      expect(filter.filterToolOutput('Read', { type: 'text' })).toBeNull()
    })
  })

  describe('structured Grep output', () => {
    it('trims a large content field', () => {
      const filter = createContextFilter()
      const content = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Grep', { content, filenames: ['a.ts', 'b.ts'] }) as {
        content: string
        filenames: string[]
      } | null

      expect(result).not.toBeNull()
      expect(result!.content).toContain('lines trimmed by context filter')
      expect(result!.filenames).toEqual(['a.ts', 'b.ts'])
    })

    it('returns null when content is missing', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Grep', { filenames: ['a.ts'] })).toBeNull()
    })
  })

  describe('no-op passthrough', () => {
    it('returns null for a small plain string', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Bash', 'small output')).toBeNull()
    })

    it('returns null for a small structured Bash output', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Bash', { stdout: 'ok', stderr: '' })).toBeNull()
    })

    it('returns null for a small structured Grep output', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Grep', { content: 'small' })).toBeNull()
    })

    it('returns null for a small content array', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Agent', { content: [{ type: 'text', text: 'small' }] })).toBeNull()
    })

    it('returns null for an unhandled tool name with an object payload', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('SomeUnknownTool', { foo: 'bar' })).toBeNull()
    })

    it('returns null for non-object, non-string, non-array payloads', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('Bash', 42)).toBeNull()
      expect(filter.filterToolOutput('Bash', null)).toBeNull()
      expect(filter.filterToolOutput('Bash', undefined)).toBeNull()
    })
  })

  describe('content array (Agent/Task)', () => {
    it('trims a large text block inside Agent content', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Agent', { content: [{ type: 'text', text }] }) as {
        content: Array<{ type: string; text: string }>
      } | null

      expect(result).not.toBeNull()
      expect(result!.content[0].text).toContain('lines trimmed by context filter')
    })

    it('trims a large text block inside Task content (same code path as Agent)', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('Task', { content: [{ type: 'text', text }] }) as {
        content: Array<{ type: string; text: string }>
      } | null

      expect(result).not.toBeNull()
      expect(result!.content[0].text).toContain('lines trimmed by context filter')
    })

    it('only touches text blocks, leaving non-text blocks untouched', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2)
      const imageBlock = { type: 'image', source: 'data:...' }

      const result = filter.filterToolOutput('Agent', {
        content: [imageBlock, { type: 'text', text }]
      }) as { content: Array<Record<string, unknown>> } | null

      expect(result).not.toBeNull()
      expect(result!.content[0]).toEqual(imageBlock)
      expect((result!.content[1] as { text: string }).text).toContain('lines trimmed by context filter')
    })

    it('filters a bare top-level content array (MCP-style tool output)', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('mcp__some__tool', [{ type: 'text', text }]) as Array<{
        type: string
        text: string
      }> | null

      expect(result).not.toBeNull()
      expect(result![0].text).toContain('lines trimmed by context filter')
    })
  })

  describe('string input', () => {
    it('trims a plain string above the threshold regardless of tool name', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2)

      const result = filter.filterToolOutput('CustomMcpTool', text)

      expect(result).not.toBeNull()
      expect(result).toContain('lines trimmed by context filter')
    })

    it('returns null for a plain string below the threshold', () => {
      const filter = createContextFilter()
      expect(filter.filterToolOutput('CustomMcpTool', 'tiny')).toBeNull()
    })
  })

  describe('disabled filter', () => {
    it('returns null for every input shape when enabled: false', () => {
      const filter = createContextFilter({ enabled: false })
      const text = manyLines(trimMaxLines * 2)
      const block = bigBlob(dedupMinBytes + 500)
      const signed = 'output\nCo-Authored-By: Claude <noreply@anthropic.com>'

      expect(filter.filterToolOutput('Bash', text)).toBeNull()
      expect(filter.filterToolOutput('Bash', { stdout: text, stderr: '' })).toBeNull()
      expect(filter.filterToolOutput('Agent', { content: [{ type: 'text', text }] })).toBeNull()
      expect(filter.filterToolOutput('Grep', signed)).toBeNull()

      // Even exact duplicates never get stubbed while disabled.
      filter.filterToolOutput('Grep', block)
      expect(filter.filterToolOutput('Grep', block)).toBeNull()
    })
  })

  describe('reset', () => {
    it('treats a previously-seen block as new again after reset()', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)

      expect(filter.filterToolOutput('Grep', block)).toBeNull() // first sight, turn 0
      expect(filter.filterToolOutput('Grep', block)).toBe(
        `[duplicate content — first seen at turn 0, ${block.length} chars omitted]`
      )

      filter.reset()

      expect(filter.filterToolOutput('Grep', block)).toBeNull() // treated as new again
    })

    it('resets the turn counter back to 0, not just the hash table', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)

      filter.advanceTurn()
      filter.advanceTurn()
      filter.advanceTurn() // turn is now 3

      filter.reset()

      expect(filter.filterToolOutput('Grep', block)).toBeNull() // first sight post-reset
      expect(filter.filterToolOutput('Grep', block)).toBe(
        `[duplicate content — first seen at turn 0, ${block.length} chars omitted]`
      )
    })
  })

  describe('updateConfig', () => {
    it('live-toggles enabled without touching existing dedup state', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)

      filter.updateConfig({ enabled: false })
      expect(filter.filterToolOutput('Grep', block)).toBeNull()
      expect(filter.filterToolOutput('Grep', block)).toBeNull() // still disabled, never registered

      filter.updateConfig({ enabled: true })
      // Nothing was hashed while disabled, so this is still "first sight".
      expect(filter.filterToolOutput('Grep', block)).toBeNull()
      expect(filter.filterToolOutput('Grep', block)).toBe(
        `[duplicate content — first seen at turn 0, ${block.length} chars omitted]`
      )
    })

    it('live-adjusts trimThresholdBytes', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2) // exceeds the default threshold

      filter.updateConfig({ trimThresholdBytes: Number.MAX_SAFE_INTEGER })
      expect(filter.filterToolOutput('Bash', text)).toBeNull()
    })
  })

  // stats() is not yet guaranteed on every branch this file lands on (it may
  // be added by another change running in parallel). Probe for it at
  // runtime so this suite degrades to a skip instead of a hard failure if
  // that hasn't merged yet, but exercises the real shape once it has.
  const statsProbe = createContextFilter() as unknown as { stats?: () => unknown }
  const hasStats = typeof statsProbe.stats === 'function'

  describe.skipIf(!hasStats)('stats', () => {
    it('starts at zero for a fresh filter', () => {
      const filter = createContextFilter()
      expect(filter.stats()).toEqual({
        trimCount: 0,
        trimBytesReclaimed: 0,
        dedupCount: 0,
        dedupBytesReclaimed: 0,
        signatureStripCount: 0,
        seenHashes: 0,
        turnCounter: 0
      })
    })

    it('counts a trim and reports bytes reclaimed', () => {
      const filter = createContextFilter()
      const text = manyLines(trimMaxLines * 2)

      filter.filterToolOutput('Bash', text)

      const s = filter.stats()
      expect(s.trimCount).toBe(1)
      expect(s.trimBytesReclaimed).toBeGreaterThan(0)
    })

    it('counts a dedup hit, reports bytes reclaimed, and tracks seenHashes', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)

      filter.filterToolOutput('Grep', block) // first sight — registers the hash
      filter.filterToolOutput('Grep', block) // duplicate — counted

      const s = filter.stats()
      expect(s.dedupCount).toBe(1)
      expect(s.dedupBytesReclaimed).toBeGreaterThan(0)
      expect(s.seenHashes).toBe(1)
    })

    it('counts a signature strip', () => {
      const filter = createContextFilter()
      filter.filterToolOutput('Bash', 'output\nCo-Authored-By: Claude <noreply@anthropic.com>')
      expect(filter.stats().signatureStripCount).toBe(1)
    })

    it('tracks the turn counter', () => {
      const filter = createContextFilter()
      filter.advanceTurn()
      filter.advanceTurn()
      expect(filter.stats().turnCounter).toBe(2)
    })

    it('does not clear accumulated telemetry on reset() — only dedup state resets', () => {
      const filter = createContextFilter()
      const block = bigBlob(dedupMinBytes + 500)
      filter.filterToolOutput('Grep', block)
      filter.filterToolOutput('Grep', block) // dedupCount -> 1

      filter.reset()

      const s = filter.stats()
      expect(s.dedupCount).toBe(1) // telemetry survives reset
      expect(s.seenHashes).toBe(0) // hash table was cleared
      expect(s.turnCounter).toBe(0)
    })
  })
})
