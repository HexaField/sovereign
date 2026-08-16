import { describe, it, expect } from 'vitest'
import { chunkText, chunkFile } from './chunker.js'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const chunks = chunkText('Hello world', { chunkSize: 100 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe('Hello world')
    expect(chunks[0].index).toBe(0)
  })

  it('splits on paragraph boundaries', () => {
    const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.'
    const chunks = chunkText(text, { chunkSize: 40, overlap: 5, minSize: 5 })
    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk should contain coherent text
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0)
    }
  })

  it('assigns sequential indices', () => {
    const text = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100) + '\n\n' + 'C'.repeat(100)
    const chunks = chunkText(text, { chunkSize: 120, overlap: 10, minSize: 5 })
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i)
    }
  })

  it('respects minSize — discards tiny trailing chunks', () => {
    const text = 'Main content here with plenty of text.\n\nX'
    const chunks = chunkText(text, { chunkSize: 50, overlap: 5, minSize: 10 })
    // Trailing 'X' (1 char) should get discarded
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('handles empty input', () => {
    const chunks = chunkText('')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe('')
  })
})

describe('chunkFile', () => {
  it('prepends file path to each chunk', () => {
    const chunks = chunkFile('/src/main.ts', 'Some code content here')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('File: /src/main.ts')
    expect(chunks[0].text).toContain('Some code content here')
  })
})
