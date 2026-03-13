import { renderMarkdown } from '../../lib/markdown.js'

export interface MarkdownContentProps {
  html: string
  class?: string
}

/** Extract language from a code block's class attribute */
export function detectLanguage(className: string): string {
  const match = className.match(/language-(\w+)/)
  return match?.[1] ?? ''
}

/** Copy text to clipboard - returns true on success */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
    return false
  } catch {
    return false
  }
}

/** Sanitize HTML to prevent XSS attacks */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  let safe = html
  // Strip script tags
  safe = safe.replace(/<script[\s\S]*?<\/script>/gi, '')
  // Strip event handler attributes
  safe = safe.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, '')
  safe = safe.replace(/\bon\w+\s*=\s*[^\s>]+/gi, '')
  // Strip javascript: URLs in href/src
  safe = safe.replace(/(href|src)\s*=\s*["']\s*javascript:[^"']*["']/gi, '$1=""')
  return safe
}

/** Process raw markdown text into sanitized HTML */
export function processMarkdown(text: string): string {
  if (!text) return ''
  const raw = renderMarkdown(text)
  return sanitizeHtml(raw)
}

export function MarkdownContent(props: MarkdownContentProps) {
  return (
    <div
      class={`markdown-content prose prose-sm max-w-none ${props.class ?? ''}`}
      innerHTML={sanitizeHtml(props.html)}
      style={{
        '--tw-prose-headings': 'var(--c-text-heading)',
        '--tw-prose-links': 'var(--c-accent)',
        '--tw-prose-code': 'var(--c-text)',
        color: 'var(--c-text)'
      }}
    />
  )
}
