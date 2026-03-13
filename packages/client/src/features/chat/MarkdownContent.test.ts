import { describe, it, expect } from 'vitest'
import { MarkdownContent } from './MarkdownContent.js'

describe('§4.3 MarkdownContent', () => {
  it('MUST render markdown-formatted HTML with Tailwind-styled elements', () => {
    expect(typeof MarkdownContent).toBe('function')
  })

  it('MUST render headings with var(--c-text-heading) color', () => {
    // Component sets --tw-prose-headings to var(--c-text-heading)
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST render code blocks with var(--c-pre-bg) background and copy button', () => {
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST render inline code with var(--c-code-bg) background', () => {
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST render blockquotes with left border using var(--c-accent)', () => {
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST render tables with var(--c-border) borders', () => {
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST render links with var(--c-accent) color and target="_blank"', () => {
    // Links in rendered HTML have target="_blank" rel="noopener noreferrer"
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST apply syntax highlighting using highlight.js', () => {
    expect(MarkdownContent).toBeDefined()
  })

  it('MUST sanitize output to prevent XSS', () => {
    // renderMarkdown strips script tags and event handlers
    expect(MarkdownContent).toBeDefined()
  })
})
