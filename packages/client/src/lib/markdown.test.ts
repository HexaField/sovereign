import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './markdown.js'

// Access internal module state for testing tilde expansion.
// The workspace file cache populates absoluteToRelative, which getHomeDir()
// scans for the /home/<user>/ or /Users/<user>/ prefix.
// We import the module and seed the cache directly via the exported refresh +
// a manual workspace load stub — but since the cache is module-private,
// the simplest approach is to test the output behaviour with markdown links
// (Phase 0), which chip unconditionally for absolute paths.

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

describe('injectCodeLinks — URL linkification inside inline code', () => {
  it('wraps a bare https URL inside an inline code span in an <a> tag', () => {
    const result = renderMarkdown('Visit `https://example.com` for docs.')
    expect(result).toContain('<code>')
    expect(result).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">')
  })

  it('wraps a bare http URL inside an inline code span', () => {
    const result = renderMarkdown('`http://localhost:3000`')
    expect(result).toContain('<a href="http://localhost:3000"')
  })

  it('preserves the <code> wrapper so styling and copy-button still apply', () => {
    const result = renderMarkdown('`https://example.com`')
    expect(result).toContain('<code>')
    expect(result).toContain('</code>')
    // The <a> must appear inside the <code>
    const codeStart = result.indexOf('<code>')
    const codeEnd = result.indexOf('</code>')
    const linkStart = result.indexOf('<a href="https://example.com"')
    expect(linkStart).toBeGreaterThan(codeStart)
    expect(linkStart).toBeLessThan(codeEnd)
  })

  it('does not linkify URLs inside fenced code blocks', () => {
    const result = renderMarkdown('```\nhttps://example.com\n```')
    expect(result).toContain('<pre>')
    // Must not inject <a> inside a pre block
    const preContent = result.slice(result.indexOf('<pre>'), result.indexOf('</pre>'))
    expect(preContent).not.toContain('<a href=')
  })

  it('leaves inline code without URLs unchanged', () => {
    const result = renderMarkdown('`npm install`')
    expect(result).toContain('<code>npm install</code>')
    expect(result).not.toContain('<a href=')
  })

  it('trims trailing punctuation from the linked URL', () => {
    const result = renderMarkdown('See `https://example.com/path.`')
    expect(result).toContain('href="https://example.com/path"')
    expect(result).not.toContain('href="https://example.com/path."')
  })

  it('decodes HTML-escaped ampersands in the href attribute', () => {
    // marked HTML-escapes & to &amp; inside code spans
    const result = renderMarkdown('`https://example.com/path?a=1&b=2`')
    // href should have real & (decoded), display text keeps &amp; (escaped)
    expect(result).toContain('href="https://example.com/path?a=1&b=2"')
  })

  it('handles multiple URLs in one code span', () => {
    const result = renderMarkdown('`https://one.com and https://two.com`')
    const linkCount = (result.match(/<a href=/g) || []).length
    expect(linkCount).toBe(2)
  })

  it('does not re-wrap URLs that are already inside an <a> tag from file chip injection', () => {
    // A plain markdown link does not produce a <code> tag, so no double-wrapping possible
    const result = renderMarkdown('[https://example.com](https://example.com)')
    const linkCount = (result.match(/<a href=/g) || []).length
    expect(linkCount).toBe(1)
  })
})

describe('file chip — tilde path expansion', () => {
  it('chips a markdown link with ~/... path even without cached home dir', () => {
    // Phase 0 handles markdown links: [label](path). ~/... paths get chipped
    // unconditionally (same as absolute paths) — the click handler resolves
    // the tilde server-side. Without a cached home dir, expandTilde returns
    // the path unchanged, but it still becomes a file-chip.
    const md = '[memory](~/.sovereign/memory/project_membrane-first-threading.md)'
    const result = renderMarkdown(md)
    expect(result).toContain('class="file-chip"')
    expect(result).toContain('data-file-path="~/.sovereign/memory/project_membrane-first-threading.md"')
    expect(result).not.toContain('<a href="~/')
  })

  it('preserves paths that do not start with ~/', () => {
    const md = '[file](/absolute/path/to/file.md)'
    const result = renderMarkdown(md)
    // Should chip as an absolute path (Phase 0 unconditional)
    expect(result).toContain('class="file-chip"')
    expect(result).toContain('data-file-path="/absolute/path/to/file.md"')
  })
})
