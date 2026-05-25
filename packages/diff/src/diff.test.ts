import { describe, it, expect } from 'vitest'
import { diffText } from './diff.js'

describe('diffText', () => {
  describe('unified diff output', () => {
    it('returns empty array for identical strings', () => {
      expect(diffText('hello\nworld', 'hello\nworld')).toEqual([])
    })

    it('returns hunks for single-line change', () => {
      const hunks = diffText('hello', 'world')
      expect(hunks).toHaveLength(1)
      expect(hunks[0].lines.some((l) => l.type === 'remove' && l.content === 'hello')).toBe(true)
      expect(hunks[0].lines.some((l) => l.type === 'add' && l.content === 'world')).toBe(true)
    })

    it('returns hunks for multi-line additions', () => {
      const hunks = diffText('a', 'a\nb\nc')
      expect(hunks).toHaveLength(1)
      const adds = hunks[0].lines.filter((l) => l.type === 'add')
      expect(adds.length).toBe(2)
    })

    it('returns hunks for multi-line deletions', () => {
      const hunks = diffText('a\nb\nc', 'a')
      expect(hunks).toHaveLength(1)
      const removes = hunks[0].lines.filter((l) => l.type === 'remove')
      expect(removes.length).toBe(2)
    })

    it('returns hunks for mixed add/remove/context lines', () => {
      const hunks = diffText('a\nb\nc', 'a\nx\nc')
      expect(hunks).toHaveLength(1)
      const types = hunks[0].lines.map((l) => l.type)
      expect(types).toContain('context')
      expect(types).toContain('add')
      expect(types).toContain('remove')
    })

    it('produces correct oldStart/oldLines/newStart/newLines', () => {
      const hunks = diffText('a\nb\nc', 'a\nx\nc')
      expect(hunks[0].oldStart).toBe(1)
      expect(hunks[0].newStart).toBe(1)
      expect(hunks[0].oldLines).toBe(3) // a, b, c context/remove
      expect(hunks[0].newLines).toBe(3) // a, x, c context/add
    })
  })

  describe('line types', () => {
    it('marks added lines with type "add"', () => {
      const hunks = diffText('a', 'a\nb')
      const adds = hunks[0].lines.filter((l) => l.type === 'add')
      expect(adds.length).toBeGreaterThan(0)
      expect(adds[0].content).toBe('b')
    })

    it('marks removed lines with type "remove"', () => {
      const hunks = diffText('a\nb', 'a')
      const removes = hunks[0].lines.filter((l) => l.type === 'remove')
      expect(removes.length).toBeGreaterThan(0)
      expect(removes[0].content).toBe('b')
    })

    it('marks unchanged lines with type "context"', () => {
      const hunks = diffText('a\nb\nc', 'a\nx\nc')
      const ctx = hunks[0].lines.filter((l) => l.type === 'context')
      expect(ctx.length).toBeGreaterThan(0)
    })
  })

  describe('line numbers', () => {
    it('assigns correct oldLineNumber for context and removed lines', () => {
      const hunks = diffText('a\nb\nc', 'a\nx\nc')
      const withOld = hunks[0].lines.filter((l) => l.oldLineNumber !== undefined)
      expect(withOld.length).toBeGreaterThan(0)
    })

    it('assigns correct newLineNumber for context and added lines', () => {
      const hunks = diffText('a\nb\nc', 'a\nx\nc')
      const withNew = hunks[0].lines.filter((l) => l.newLineNumber !== undefined)
      expect(withNew.length).toBeGreaterThan(0)
    })

    it('omits oldLineNumber for added lines', () => {
      const hunks = diffText('a', 'a\nb')
      const adds = hunks[0].lines.filter((l) => l.type === 'add')
      for (const a of adds) {
        expect(a.oldLineNumber).toBeUndefined()
      }
    })

    it('omits newLineNumber for removed lines', () => {
      const hunks = diffText('a\nb', 'a')
      const removes = hunks[0].lines.filter((l) => l.type === 'remove')
      for (const r of removes) {
        expect(r.newLineNumber).toBeUndefined()
      }
    })
  })

  describe('hunks', () => {
    it('groups nearby changes into a single hunk', () => {
      const hunks = diffText('a\nb\nc\nd', 'a\nx\nc\ny')
      expect(hunks).toHaveLength(1)
    })

    it('splits distant changes into separate hunks', () => {
      // Create text with changes far apart (>6 context lines between)
      const old = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
      const lines = old.split('\n')
      lines[0] = 'changed0'
      lines[19] = 'changed19'
      const hunks = diffText(old, lines.join('\n'))
      expect(hunks.length).toBe(2)
    })

    it('includes context lines around changes', () => {
      const old = 'a\nb\nc\nd\ne\nf\ng'
      const nw = 'a\nb\nc\nX\ne\nf\ng'
      const hunks = diffText(old, nw)
      expect(hunks).toHaveLength(1)
      const ctx = hunks[0].lines.filter((l) => l.type === 'context')
      expect(ctx.length).toBeGreaterThan(0)
    })
  })

  describe('edge cases', () => {
    it('handles empty old text (all additions)', () => {
      const hunks = diffText('', 'a\nb')
      expect(hunks).toHaveLength(1)
      expect(hunks[0].lines.every((l) => l.type === 'add')).toBe(true)
    })

    it('handles empty new text (all deletions)', () => {
      const hunks = diffText('a\nb', '')
      expect(hunks).toHaveLength(1)
      expect(hunks[0].lines.every((l) => l.type === 'remove')).toBe(true)
    })

    it('handles both empty', () => {
      expect(diffText('', '')).toEqual([])
    })

    it('handles large files efficiently', () => {
      const old = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
      const lines = old.split('\n')
      lines[500] = 'changed'
      const start = Date.now()
      const hunks = diffText(old, lines.join('\n'))
      expect(Date.now() - start).toBeLessThan(1000)
      expect(hunks.length).toBeGreaterThan(0)
    })
  })
})
