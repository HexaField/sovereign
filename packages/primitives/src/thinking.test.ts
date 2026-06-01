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
    expect(stripThinkingBlocks('a <think>outer <think>inner</think> still</think> b')).toBe('a  still b')
  })

  // ── REGRESSION (production bug): the previous "strip unclosed tag to
  // end of string" behaviour truncated the agent's own narration when it
  // happened to mention thinking-tag names as literal text (e.g. inside
  // inline code: `<thinking>` while explaining what the bug looks like).
  // On the live thread it chopped 1351 chars off a 2706-char assistant
  // message — the user saw the response visibly cut off mid-sentence.
  // The new contract: unclosed thinking tags are LEFT IN PLACE. We only
  // strip well-formed PAIRS, plus orphan close tags (which are harmless
  // to remove). Modern Anthropic models emit reasoning via typed
  // `{type:'thinking'}` content blocks, NOT XML-style tags, so a genuine
  // unclosed `<thinking>` is rare and "shows a partial tag" beats
  // "deletes most of the assistant's message".
  it('MUST NOT strip text after an unclosed thinking tag (preserves legitimate mentions)', () => {
    // Mid-text mention — what the production bug was
    expect(stripThinkingBlocks('no `<thinking>` tags here, just discussing')).toBe(
      'no `<thinking>` tags here, just discussing'
    )
    // Multi-line, mention deep in a long body
    const long = 'A'.repeat(500) + ' mentions <thinking> in a sentence ' + 'B'.repeat(500)
    expect(stripThinkingBlocks(long)).toBe(long)
    // Other tag types
    expect(stripThinkingBlocks('we use the <think> word a lot')).toBe('we use the <think> word a lot')
  })

  it('MUST clean up orphan closing tags (no opening)', () => {
    // Orphan close tags are unambiguously stray — strip them. This is
    // the safe half of the previous unclosed-handler behaviour.
    expect(stripThinkingBlocks('text </thinking> more')).toBe('text  more')
    expect(stripThinkingBlocks('a </think> b </thought> c')).toBe('a  b  c')
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
