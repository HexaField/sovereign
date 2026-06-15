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

describe('file chip — markdown link resolution', () => {
  it('chips file:/// URI even when path is not in workspace cache', () => {
    const md =
      '[`011-knowledge-ecology-ontology-plan.md`](file:///Users/josh/workspaces/atlasresearch/.specs/011-knowledge-ecology-ontology-plan.md)'
    const result = renderMarkdown(md)
    expect(result).toContain('class="file-chip"')
    expect(result).toContain(
      'data-file-path="/Users/josh/workspaces/atlasresearch/.specs/011-knowledge-ecology-ontology-plan.md"'
    )
    // label text comes from the inner content
    expect(result).toContain('011-knowledge-ecology-ontology-plan.md')
    // must NOT remain as a plain <a> link
    expect(result).not.toMatch(/<a\s+href="file:\/\//)
  })

  it('chips file://localhost/ URI', () => {
    const md = '[plan](file://localhost/Users/josh/workspaces/atlasresearch/.specs/plan.md)'
    const result = renderMarkdown(md)
    expect(result).toContain('class="file-chip"')
    expect(result).toContain('data-file-path="/Users/josh/workspaces/atlasresearch/.specs/plan.md"')
  })

  it('decodes percent-encoded characters in file:// URIs', () => {
    const md = '[file](file:///Users/josh/my%20docs/plan.md)'
    const result = renderMarkdown(md)
    expect(result).toContain('class="file-chip"')
    expect(result).toContain('data-file-path="/Users/josh/my docs/plan.md"')
  })

  it('preserves external https:// links as <a> tags', () => {
    const md = '[docs](https://example.com/page)'
    const result = renderMarkdown(md)
    expect(result).toContain('<a href="https://example.com/page"')
    expect(result).not.toContain('class="file-chip"')
  })

  it('uses label text as chip display name', () => {
    const md = '[My Plan](file:///Users/josh/workspaces/atlasresearch/.specs/plan.md)'
    const result = renderMarkdown(md)
    expect(result).toContain('My Plan')
    expect(result).toContain('class="file-chip"')
  })
})
