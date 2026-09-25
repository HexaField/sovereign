import { describe, it, expect } from 'vitest'
import { activeFileEffect } from './file-events.js'

describe('activeFileEffect', () => {
  const open = '/w/notes/deep/open.md'

  it('reloads the open file when it changes, and clears it when it is deleted', () => {
    expect(activeFileEffect(open, open, 'modified')).toBe('reload')
    expect(activeFileEffect(open, open, 'created')).toBe('reload')
    expect(activeFileEffect(open, open, 'deleted')).toBe('clear')
  })

  it('clears the open file when a parent directory is deleted or moved away', () => {
    expect(activeFileEffect(open, '/w/notes', 'deleted')).toBe('clear')
    expect(activeFileEffect(open, '/w/notes/deep/', 'deleted')).toBe('clear')
  })

  it('ignores siblings, name prefixes, parent changes, and an empty panel', () => {
    expect(activeFileEffect(open, '/w/notes/deep/other.md', 'deleted')).toBeNull()
    expect(activeFileEffect(open, '/w/note', 'deleted')).toBeNull() // "/w/note" is not a parent of "/w/notes/…"
    expect(activeFileEffect(open, '/w/notes', 'modified')).toBeNull()
    expect(activeFileEffect(null, open, 'deleted')).toBeNull()
  })
})
