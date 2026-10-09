import { describe, it, expect } from 'vitest'
import { fileExtension, fileRenderKind, fileViewUrl } from './file-view.js'

describe('fileRenderKind', () => {
  it('renders HTML as a page, images as images, markdown rendered, the rest as text', () => {
    expect(fileRenderKind('/a/tree.html')).toBe('html')
    expect(fileRenderKind('/a/OLD.HTM')).toBe('html')
    for (const p of ['/a/x.png', '/a/x.svg', '/a/x.JPG', '/a/x.webp']) expect(fileRenderKind(p)).toBe('image')
    expect(fileRenderKind('/a/notes.md')).toBe('markdown')
    expect(fileRenderKind('/a/data.json')).toBe('text')
    expect(fileRenderKind('/a/Makefile')).toBe('text')
  })

  it('reads the extension of the file name, not of a dotted directory', () => {
    expect(fileExtension('/home/u/.sovereign/README')).toBe('')
    expect(fileExtension('/home/u/.sovereign/x.html')).toBe('html')
  })
})

describe('fileViewUrl', () => {
  it('keeps the path in the URL path, so relative links resolve beside the file', () => {
    expect(fileViewUrl('/home/u/plans/tree.html')).toBe('/api/files/view/home/u/plans/tree.html')
  })

  it('encodes each segment and keeps the slashes', () => {
    expect(fileViewUrl('/home/u/my plans/a#1.html')).toBe('/api/files/view/home/u/my%20plans/a%231.html')
  })

  it('passes ~/ paths through for the server to expand', () => {
    expect(fileViewUrl('~/.sovereign/x.svg')).toBe('/api/files/view/~/.sovereign/x.svg')
  })

  it('adds a cache-busting version when given one', () => {
    expect(fileViewUrl('/home/u/x.png', 42)).toBe('/api/files/view/home/u/x.png?v=42')
  })
})
