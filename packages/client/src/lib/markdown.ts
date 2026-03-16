// Markdown rendering with link and image customization

import { marked } from 'marked'

const renderer = new marked.Renderer()

// External links get target="_blank" and rel="noopener noreferrer"
renderer.link = ({ href, text }) => {
  const isExternal = href?.startsWith('http://') || href?.startsWith('https://')
  const attrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : ''
  return `<a href="${href ?? ''}"${attrs}>${text}</a>`
}

// Images get max-width and rounded corners
renderer.image = ({ href, text }) => {
  return `<img src="${href ?? ''}" alt="${text ?? ''}" style="max-width: 100%; border-radius: 0.375rem;" />`
}

marked.setOptions({ renderer, breaks: true, gfm: true })

/**
 * Convert markdown text to HTML.
 * Uses `marked` for markdown-to-HTML conversion.
 * Sanitization is handled by the consuming component (MarkdownContent.sanitizeHtml).
 */
export function renderMarkdown(text: string): string {
  try {
    let html = marked.parse(text, { async: false }) as string
    html = injectFileChips(html)
    return html
  } catch {
    return escapeHtml(text)
  }
}

/** Inject clickable file chips for absolute file paths in rendered HTML.
 *  Skips paths already inside tags or code blocks. */
function injectFileChips(html: string): string {
  // Match absolute paths that look like files (have an extension)
  const pathRe = /(\/[\w.+-]+(?:\/[\w.+-]+)*\.\w{1,10})/g
  // Split on HTML tags to avoid replacing inside tag attributes
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith('<')) return part
      return part.replace(pathRe, (_match, path) => {
        const name = path.split('/').pop() || path
        return `<span class="file-chip" data-file-path="${path}" title="${path}">📄 ${name}<button class="file-chip-copy" data-copy-path="${path}" title="Copy path">⧉</button></span>`
      })
    })
    .join('')
}

/** Force refresh of workspace file cache (called after final turns) */
export function refreshWorkspaceFiles(): void {
  // Placeholder for future workspace file cache integration
}

/**
 * Strip thinking blocks from message content.
 * Removes tags AND content between them, plus unclosed blocks.
 * Protects all backtick patterns (inline code and code blocks) from false matches.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text) return text

  // Protect all code blocks and inline code from being matched
  const codeSlots: string[] = []
  let protected_ = text.replace(/(`{1,})([\s\S]*?)\1/g, (m) => {
    codeSlots.push(m)
    return `\x00CODE${codeSlots.length - 1}\x00`
  })

  // Strip complete blocks (content between open and close tags)
  protected_ = protected_.replace(/<(think(?:ing)?|thought|antthinking)[^>]*>[\s\S]*?<\/\1>/gi, '')
  protected_ = protected_.replace(/<details\s+class="thinking">[\s\S]*?<\/details>/gi, '')

  // Strip unclosed blocks (tag opened but not yet closed — streaming mid-thought)
  protected_ = protected_.replace(/<(?:think(?:ing)?|thought|antthinking)[^>]*>[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<details\s+class="thinking">[\s\S]*$/gi, '')

  // Strip orphaned closing tags
  protected_ = protected_.replace(/<\/(?:think(?:ing)?|thought|antthinking)[^>]*>/gi, '')

  // Restore code blocks
  return protected_.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeSlots[Number(i)]).trim()
}

export function escapeHtml(text: string): string {
  if (typeof document === 'undefined') {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
