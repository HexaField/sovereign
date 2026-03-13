import { describe, it } from 'vitest'

describe('§2.3 Thinking Block Stripping', () => {
  it.todo('MUST remove all content between <think>...</think> tags')
  it.todo('MUST remove all content between <thinking>...</thinking> tags')
  it.todo('MUST remove all content between <thought>...</thought> tags')
  it.todo('MUST remove all content between <antThinking>...</antThinking> tags')
  it.todo('MUST handle nested thinking tags (take the outermost pair)')
  it.todo('MUST handle unclosed thinking tags (strip from opening tag to end of string)')
  it.todo('MUST NOT strip content inside fenced code blocks (triple backtick regions)')
  it.todo('MUST handle multiple thinking blocks in a single text')
  it.todo('MUST preserve all whitespace and content outside of thinking blocks')
})
