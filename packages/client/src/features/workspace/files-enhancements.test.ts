import { describe, it, expect } from 'vitest'

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

  it.todo('§P.6 SHOULD implement markdown preview toggle')
})
