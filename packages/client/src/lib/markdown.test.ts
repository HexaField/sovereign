import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown.js'

describe('renderMarkdown', () => {
  it('converts markdown to HTML', () => {
    const result = renderMarkdown('**bold**')
    expect(result).toContain('<strong>bold</strong>')
  })

  it('converts headings', () => {
    const result = renderMarkdown('# Hello')
    expect(result).toContain('<h1')
    expect(result).toContain('Hello')
  })

  it('converts links', () => {
    const result = renderMarkdown('[link](https://example.com)')
    expect(result).toContain('<a href="https://example.com"')
    expect(result).toContain('target="_blank"')
  })

  it('handles empty string', () => {
    const result = renderMarkdown('')
    expect(result).toBe('')
  })

  it('converts code blocks', () => {
    const result = renderMarkdown('```js\nconst x = 1\n```')
    expect(result).toContain('<code')
    expect(result).toContain('const x = 1')
  })
})
