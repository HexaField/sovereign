import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch
const mockFetch = vi.fn()
globalThis.fetch = mockFetch

import {
  buildTreeUrl,
  getFileExtension,
  createFileOrFolder,
  renameFileOrFolder,
  deleteFileOrFolder
} from './FileExplorerPanel.js'

beforeEach(() => {
  mockFetch.mockReset()
})

describe('buildTreeUrl', () => {
  it('encodes projectId in URL', () => {
    expect(buildTreeUrl('my/project')).toBe('/api/files/tree?project=my%2Fproject')
  })

  it('handles simple projectId', () => {
    expect(buildTreeUrl('proj1')).toBe('/api/files/tree?project=proj1')
  })
})

describe('getFileExtension', () => {
  it('returns extension for normal files', () => {
    expect(getFileExtension('file.ts')).toBe('ts')
    expect(getFileExtension('archive.tar.gz')).toBe('gz')
  })

  it('returns empty string for no extension', () => {
    expect(getFileExtension('Dockerfile')).toBe('')
    expect(getFileExtension('Makefile')).toBe('')
  })

  it('handles dotfiles', () => {
    expect(getFileExtension('.gitignore')).toBe('gitignore')
  })

  it('handles empty string', () => {
    expect(getFileExtension('')).toBe('')
  })
})

describe('createFileOrFolder', () => {
  it('sends POST with correct body for file', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })
    const result = await createFileOrFolder('/proj', 'src', 'index.ts', 'file')
    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('/api/files/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '/proj', path: 'src/index.ts', type: 'file' })
    })
  })

  it('sends POST for directory', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })
    const result = await createFileOrFolder('/proj', '', 'components', 'directory')
    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/files/create',
      expect.objectContaining({
        body: JSON.stringify({ project: '/proj', path: '/components', type: 'directory' })
      })
    )
  })

  it('returns false on failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false })
    const result = await createFileOrFolder('/proj', 'src', 'bad.ts', 'file')
    expect(result).toBe(false)
  })
})

describe('renameFileOrFolder', () => {
  it('sends rename request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })
    const result = await renameFileOrFolder('/proj', 'old.ts', 'new.ts')
    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '/proj', oldPath: 'old.ts', newName: 'new.ts' })
    })
  })

  it('returns false on failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false })
    expect(await renameFileOrFolder('/p', 'a', 'b')).toBe(false)
  })
})

describe('deleteFileOrFolder', () => {
  it('sends delete request', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true })
    const result = await deleteFileOrFolder('/proj', 'src/old.ts')
    expect(result).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('/api/files/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: '/proj', path: 'src/old.ts' })
    })
  })
})
