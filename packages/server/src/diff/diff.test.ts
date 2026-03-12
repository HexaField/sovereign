import { describe, it } from 'vitest'

describe('diffText', () => {
  describe('unified diff output', () => {
    it.todo('returns empty array for identical strings')
    it.todo('returns hunks for single-line change')
    it.todo('returns hunks for multi-line additions')
    it.todo('returns hunks for multi-line deletions')
    it.todo('returns hunks for mixed add/remove/context lines')
    it.todo('produces correct oldStart/oldLines/newStart/newLines')
  })

  describe('line types', () => {
    it.todo('marks added lines with type "add"')
    it.todo('marks removed lines with type "remove"')
    it.todo('marks unchanged lines with type "context"')
  })

  describe('line numbers', () => {
    it.todo('assigns correct oldLineNumber for context and removed lines')
    it.todo('assigns correct newLineNumber for context and added lines')
    it.todo('omits oldLineNumber for added lines')
    it.todo('omits newLineNumber for removed lines')
  })

  describe('hunks', () => {
    it.todo('groups nearby changes into a single hunk')
    it.todo('splits distant changes into separate hunks')
    it.todo('includes context lines around changes')
  })

  describe('edge cases', () => {
    it.todo('handles empty old text (all additions)')
    it.todo('handles empty new text (all deletions)')
    it.todo('handles both empty')
    it.todo('handles large files efficiently')
  })
})
