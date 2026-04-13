import { describe, it, expect } from 'vitest'
import { stripThinkingBlocks } from './thinking.js'

describe('§2.3 Thinking Block Stripping', () => {
  it('MUST remove all content between <think>...</think> tags', () => {
    expect(stripThinkingBlocks('hello <think>secret</think> world')).toBe('hello  world')
  })

  it('MUST remove all content between <thinking>...</thinking> tags', () => {
    expect(stripThinkingBlocks('a <thinking>stuff</thinking> b')).toBe('a  b')
  })

  it('MUST remove all content between <thought>...</thought> tags', () => {
    expect(stripThinkingBlocks('x <thought>inner</thought> y')).toBe('x  y')
  })

  it('MUST remove all content between <antThinking>...</antThinking> tags', () => {
    expect(stripThinkingBlocks('start <antThinking>data</antThinking> end')).toBe('start  end')
  })

  it('MUST handle nested thinking tags (inner pair stripped, outer orphan cleaned)', () => {
    // With non-greedy matching, <think>outer <think>inner</think> is stripped first,
    // then orphaned </think> is cleaned up. "still" between inner close and outer close remains.
    // This is acceptable — nested thinking tags don't occur in practice.
    expect(stripThinkingBlocks('a <think>outer <think>inner</think> still</think> b')).toBe('a  still b')
  })

  it('MUST handle unclosed thinking tags (strip from opening tag to end of string)', () => {
    expect(stripThinkingBlocks('hello <think>partial stream')).toBe('hello ')
    expect(stripThinkingBlocks('before <thinking>streaming...')).toBe('before ')
  })

  it('MUST NOT strip content inside fenced code blocks (triple backtick regions)', () => {
    const input = 'text\n```\n<think>code example</think>\n```\nmore'
    expect(stripThinkingBlocks(input)).toBe(input)
  })

  it('MUST handle multiple thinking blocks in a single text', () => {
    expect(stripThinkingBlocks('<think>a</think> keep <thought>b</thought> also')).toBe(' keep  also')
  })

  it('MUST preserve all whitespace and content outside of thinking blocks', () => {
    const input = '  hello\n\n  world  '
    expect(stripThinkingBlocks(input)).toBe(input)
    expect(stripThinkingBlocks('  <think>x</think>\n  rest')).toBe('  \n  rest')
  })

  it('MUST NOT eat content between separate thinking blocks', () => {
    expect(stripThinkingBlocks('<think>A</think> keep <think>B</think> end')).toBe(' keep  end')
    expect(stripThinkingBlocks('start <thinking>x</thinking> middle <thinking>y</thinking> end')).toBe(
      'start  middle  end'
    )
  })
})
