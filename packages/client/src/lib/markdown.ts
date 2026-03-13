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

marked.setOptions({ renderer })

/**
 * Convert markdown text to HTML.
 * Uses `marked` for markdown-to-HTML conversion.
 * Sanitization is handled by the consuming component (MarkdownContent.sanitizeHtml).
 */
export function renderMarkdown(text: string): string {
  try {
    return marked.parse(text, { async: false }) as string
  } catch {
    return escapeHtml(text)
  }
}

export function escapeHtml(text: string): string {
  if (typeof document === 'undefined') {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
