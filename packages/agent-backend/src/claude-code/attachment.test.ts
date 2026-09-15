import { describe, it, expect } from 'vitest'
import { attachmentToContentBlock, buildLocalLlmContent } from './attachment.js'
import type { Attachment } from '@sovereign/core'

// ── attachmentToContentBlock ───────────────────────────────────────────

describe('attachmentToContentBlock', () => {
  it('converts image attachment to base64 image block', () => {
    const att: Attachment = {
      name: 'photo.png',
      mediaType: 'image/png',
      data: Buffer.from('fake-png-data'),
      path: '/uploads/abc-photo.png'
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('image')
    expect(block.source.type).toBe('base64')
    expect(block.source.media_type).toBe('image/png')
    expect(block.source.data).toBe(Buffer.from('fake-png-data').toString('base64'))
  })

  it('converts PDF attachment to base64 document block', () => {
    const att: Attachment = {
      name: 'report.pdf',
      mediaType: 'application/pdf',
      data: Buffer.from('%PDF-fake'),
      path: '/uploads/abc-report.pdf'
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('document')
    expect(block.source.media_type).toBe('application/pdf')
  })

  it('emits path reference for text file with path — never inlines content', () => {
    const att: Attachment = {
      name: 'data.csv',
      mediaType: 'text/csv',
      path: '/uploads/abc-data.csv'
      // No data field — text files should not load content
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('text')
    expect(block.text).toContain('/uploads/abc-data.csv')
    expect(block.text).toContain('data.csv')
    // Must NOT contain inlined file content
    expect(block.text).not.toContain('---')
  })

  it('emits path reference for JSON file — does not inline', () => {
    const att: Attachment = {
      name: 'config.json',
      mediaType: 'application/json',
      path: '/uploads/abc-config.json'
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('text')
    expect(block.text).toContain('/uploads/abc-config.json')
    expect(block.text).not.toContain('{')
  })

  it('emits path reference for large log file — does not inline', () => {
    const att: Attachment = {
      name: 'server.log',
      mediaType: 'text/plain',
      path: '/uploads/abc-server.log'
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('text')
    expect(block.text).toContain('/uploads/abc-server.log')
  })

  it('falls back to inline content for text file without path (legacy)', () => {
    const content = 'col1,col2\nval1,val2'
    const att: Attachment = {
      name: 'legacy.csv',
      mediaType: 'text/csv',
      data: Buffer.from(content)
      // No path — legacy attachment
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('text')
    expect(block.text).toContain('--- legacy.csv ---')
    expect(block.text).toContain(content)
  })

  it('handles attachment with neither path nor data gracefully', () => {
    const att: Attachment = {
      name: 'mystery.bin',
      mediaType: 'application/octet-stream'
    }
    const block = attachmentToContentBlock(att)
    expect(block.type).toBe('text')
    expect(block.text).toContain('mystery.bin')
    expect(block.text).toContain('no content available')
  })

  it('handles all supported image MIME types', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
      const att: Attachment = {
        name: `img.${mime.split('/')[1]}`,
        mediaType: mime,
        data: Buffer.from('img-data')
      }
      const block = attachmentToContentBlock(att)
      expect(block.type).toBe('image')
      expect(block.source.media_type).toBe(mime)
    }
  })

  it('image without data does not produce image block', () => {
    const att: Attachment = {
      name: 'broken.png',
      mediaType: 'image/png',
      path: '/uploads/broken.png'
      // No data — broken upload
    }
    const block = attachmentToContentBlock(att)
    // Falls through to path reference since no data for base64
    expect(block.type).toBe('text')
    expect(block.text).toContain('/uploads/broken.png')
  })
})

// ── buildLocalLlmContent ───────────────────────────────────────────────

describe('buildLocalLlmContent', () => {
  it('returns plain text when no attachments', () => {
    expect(buildLocalLlmContent('hello')).toBe('hello')
    expect(buildLocalLlmContent('hello', [])).toBe('hello')
    expect(buildLocalLlmContent('hello', undefined)).toBe('hello')
  })

  it('emits path reference for text file — never inlines content', () => {
    const result = buildLocalLlmContent('check this file', [
      { name: 'data.csv', mediaType: 'text/csv', path: '/uploads/data.csv' }
    ])
    expect(result).toContain('/uploads/data.csv')
    expect(result).toContain('check this file')
    // Must NOT inline file content
    expect(result).not.toContain('---')
  })

  it('notes binary files as not forwarded', () => {
    const result = buildLocalLlmContent('see image', [
      { name: 'photo.png', mediaType: 'image/png', data: Buffer.from('img') }
    ])
    expect(result).toContain('binary file, not forwarded')
  })

  it('falls back to inline for text file without path (legacy)', () => {
    const result = buildLocalLlmContent('review', [
      { name: 'old.txt', mediaType: 'text/plain', data: Buffer.from('legacy content') }
    ])
    expect(result).toContain('--- old.txt ---')
    expect(result).toContain('legacy content')
  })

  it('handles mixed attachment types', () => {
    const result = buildLocalLlmContent('mixed', [
      { name: 'photo.jpg', mediaType: 'image/jpeg', data: Buffer.from('img') },
      { name: 'data.csv', mediaType: 'text/csv', path: '/uploads/data.csv' },
      { name: 'report.pdf', mediaType: 'application/pdf', data: Buffer.from('pdf') }
    ])
    expect(result).toContain('binary file, not forwarded')
    expect(result).toContain('/uploads/data.csv')
    expect(result).not.toContain('---')
  })
})
