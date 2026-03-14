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
    return marked.parse(text, { async: false }) as string
  } catch {
    return escapeHtml(text)
  }
}

/**
 * Strip thinking blocks from message content.
 * Removes:
 *   - <details class="thinking">...</details>
 *   - <antThinking>...</antThinking>
 *   - <thinking>...</thinking>
 *   - <think>...</think>
 *   - <thought>...</thought>
 * Protects code blocks (``` ... ```) from false matches.
 */
export function stripThinkingBlocks(text: string): string {
  if (!text) return text

  // Extract code blocks to protect them from replacement
  const codeBlocks: string[] = []
  const placeholder = '\x00CB'
  let protected_ = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return `${placeholder}${codeBlocks.length - 1}${placeholder}`
  })

  // Remove thinking block patterns (including unclosed blocks at end of streaming)
  protected_ = protected_.replace(/<details\s+class="thinking">[\s\S]*?<\/details>/gi, '')
  protected_ = protected_.replace(/<antThinking>[\s\S]*?<\/antThinking>/gi, '')
  protected_ = protected_.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
  protected_ = protected_.replace(/<think>[\s\S]*?<\/think>/gi, '')
  protected_ = protected_.replace(/<thought>[\s\S]*?<\/thought>/gi, '')

  // Remove unclosed thinking blocks (streaming mid-thought)
  protected_ = protected_.replace(/<details\s+class="thinking">[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<antThinking>[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<thinking>[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<think>[\s\S]*$/gi, '')
  protected_ = protected_.replace(/<thought>[\s\S]*$/gi, '')

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    protected_ = protected_.replace(`${placeholder}${i}${placeholder}`, codeBlocks[i])
  }

  return protected_.trim()
}

export function escapeHtml(text: string): string {
  if (typeof document === 'undefined') {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}
