import { describe, it, expect } from 'vitest'
import { stripThinkingBlocks } from './markdown.js'

// §P.3.5 Streaming HTML — strip thinking blocks

describe('§P.3.5 stripThinkingBlocks', () => {
  it('SHOULD remove <details class="thinking">...</details> blocks', () => {
    const input = 'Hello <details class="thinking">inner thought</details> world'
    expect(stripThinkingBlocks(input)).toBe('Hello  world')
  })

  it('SHOULD remove <antThinking>...</antThinking> blocks', () => {
    const input = 'Before <antThinking>some thinking</antThinking> after'
    expect(stripThinkingBlocks(input)).toBe('Before  after')
  })

  it('SHOULD remove <thinking>...</thinking> blocks', () => {
    const input = 'A <thinking>deep thought</thinking> B'
    expect(stripThinkingBlocks(input)).toBe('A  B')
  })

  it('SHOULD remove <think>...</think> blocks', () => {
    const input = 'X <think>hmm</think> Y'
    expect(stripThinkingBlocks(input)).toBe('X  Y')
  })

  it('SHOULD remove <thought>...</thought> blocks', () => {
    const input = 'Start <thought>pondering</thought> end'
    expect(stripThinkingBlocks(input)).toBe('Start  end')
  })

  it('SHOULD protect code blocks from false matches', () => {
    const input = '```\n<thinking>in code</thinking>\n```'
    expect(stripThinkingBlocks(input)).toBe('```\n<thinking>in code</thinking>\n```')
  })

  it('SHOULD handle unclosed thinking blocks (streaming mid-thought)', () => {
    const input = 'Hello <antThinking>still thinking...'
    expect(stripThinkingBlocks(input)).toBe('Hello')
  })

  it('SHOULD handle empty string', () => {
    expect(stripThinkingBlocks('')).toBe('')
  })

  it('SHOULD handle null/undefined gracefully', () => {
    expect(stripThinkingBlocks(null as any)).toBe(null)
    expect(stripThinkingBlocks(undefined as any)).toBe(undefined)
  })

  it('SHOULD handle text with no thinking blocks', () => {
    expect(stripThinkingBlocks('Just normal text')).toBe('Just normal text')
  })
})
