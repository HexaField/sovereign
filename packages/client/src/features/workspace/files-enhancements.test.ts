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

  it('§P.6 SHOULD implement markdown preview toggle', () => {
    // Verify InputArea has markdown preview toggle implemented
    const src = fs.readFileSync(
      path.resolve(__dirname, '../chat/InputArea.tsx'),
      'utf-8'
    )
    expect(src).toContain('markdownPreview')
    expect(src).toContain('renderMarkdown')
    expect(src).toContain('Preview markdown')
    // Eye icon SVG for toggle
    expect(src).toContain('Hide preview')
  })
})
