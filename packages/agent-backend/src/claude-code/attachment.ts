// Attachment → Claude API content block conversion.
//
// Extracted from claude-code.ts so the mapping logic can be unit-tested
// without spinning up the full backend.

import type { Attachment } from '@sovereign/core'

// MIME types the Claude API accepts as image content blocks.
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Convert an Attachment to the appropriate Claude API content block.
 *  - Known image types → `type: 'image'` with base64 data
 *  - PDF → `type: 'document'` with base64 data
 *  - Text-based files with a disk path → `type: 'text'` with a path
 *    reference so the agent reads the file via its Read tool
 *  - Text-based files without a path (legacy) → `type: 'text'` with
 *    inline content (backward compat) */
export function attachmentToContentBlock(att: Attachment): any {
  if (IMAGE_MIME.has(att.mediaType) && att.data) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: att.mediaType, data: att.data.toString('base64') }
    }
  }
  if (att.mediaType === 'application/pdf' && att.data) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: att.data.toString('base64') }
    }
  }
  // Text-based files: emit a path reference so the agent reads the file
  // with its Read tool. This prevents large files from flooding the prompt.
  if (att.path) {
    return { type: 'text', text: `[File attached: ${att.name} — ${att.path}]` }
  }
  // Legacy fallback: no path available, inline the content.
  if (att.data) {
    const textContent = att.data.toString('utf-8')
    return { type: 'text', text: `--- ${att.name} ---\n${textContent}` }
  }
  // Neither path nor data — mention the file exists but can't be accessed.
  return { type: 'text', text: `[File attached: ${att.name} (${att.mediaType}) — no content available]` }
}

/** Build user content string for local-LLM backends (no multimodal).
 *  Text files get a path reference; binary files get a note. */
export function buildLocalLlmContent(text: string, attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return text
  const parts: string[] = text ? [text] : []
  for (const att of attachments) {
    if (IMAGE_MIME.has(att.mediaType) || att.mediaType === 'application/pdf') {
      parts.push(`[Attachment "${att.name}" (${att.mediaType}) — binary file, not forwarded to this model.]`)
    } else if (att.path) {
      parts.push(`[File attached: ${att.name} — ${att.path}]`)
    } else if (att.data) {
      parts.push(`--- ${att.name} ---\n${att.data.toString('utf-8')}`)
    } else {
      parts.push(`[File attached: ${att.name} (${att.mediaType}) — no content available]`)
    }
  }
  return parts.join('\n\n')
}
