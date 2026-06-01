import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('§P.6 File Explorer Enhancements', () => {
  it('§P.6 exports file operation helpers', async () => {
    const mod = await import('../workspace/panels/FileExplorerPanel.js')
    expect(typeof mod.createFileOrFolder).toBe('function')
    expect(typeof mod.renameFileOrFolder).toBe('function')
    expect(typeof mod.deleteFileOrFolder).toBe('function')
  })

  it('§P.6 exports buildTreeUrl and getFileExtension', async () => {
    const { buildTreeUrl, getFileExtension } = await import('../workspace/panels/FileExplorerPanel.js')
    expect(buildTreeUrl('myproj')).toContain('project=myproj')
    expect(getFileExtension('foo.ts')).toBe('ts')
    expect(getFileExtension('noext')).toBe('')
  })

  // Markdown-preview toggle in the chat input has never been implemented in
  // InputArea.tsx — the source contains none of the referenced symbols. Marked
  // as a pending TODO so the test reflects reality. When the feature lands,
  // replace this with a behavioural test (mount the component, click the
  // toggle, assert rendered preview) rather than a grep-the-source check —
  // string-matching against source is brittle and false-positive prone.
  it.todo('§P.6 SHOULD implement markdown preview toggle in InputArea', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../chat/InputArea.tsx'), 'utf-8')
    expect(src).toContain('markdownPreview')
    expect(src).toContain('renderMarkdown')
    expect(src).toContain('Preview markdown')
    expect(src).toContain('Hide preview')
  })
})
