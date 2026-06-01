// Backend-agnostic thinking-block stripping.

const THINKING_TAGS = ['think', 'thinking', 'thought', 'antThinking']

/**
 * Strip thinking blocks from text, preserving fenced code blocks.
 * Handles nested tags (outermost wins) and multiple blocks.
 *
 * Contract: only WELL-FORMED `<tag>...</tag>` pairs are removed.
 * Unclosed opening tags (`<tag>` with no matching `</tag>`) are LEFT
 * IN PLACE. The previous "strip from unclosed tag to end of string"
 * behaviour silently truncated agent messages that mentioned tag names
 * as literal text — including this codebase's own diagnostic output
 * (e.g. "no `<thinking>` tags, no prepended reasoning"), which the
 * regex matched as an opening tag and deleted everything after.
 *
 * Modern Anthropic models emit reasoning via typed `{type:'thinking'}`
 * content blocks, not XML-style tags, so a genuine unclosed XML
 * thinking emission is rare. When it does happen (e.g. a streaming
 * abort mid-block), the cost of leaving a visible `<thinking>` open
 * tag is far lower than the cost of silently chopping off the rest of
 * the assistant's message.
 */
export function stripThinkingBlocks(text: string): string {
  // Protect fenced code blocks by replacing them with placeholders so
  // the tag-matching regex can't reach inside them.
  const codeBlocks: string[] = []
  const placeholder = '\x00CODE_BLOCK\x00'
  let protected_ = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return placeholder + (codeBlocks.length - 1) + '\x00'
  })

  // Strip each thinking tag type — run multiple passes to handle nesting.
  let changed = true
  while (changed) {
    const before = protected_
    for (const tag of THINKING_TAGS) {
      protected_ = protected_.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), '')
    }
    changed = protected_ !== before
  }

  // Clean up orphaned closing tags (no matching opening). These are
  // unambiguously stray and safe to remove. We do NOT strip unclosed
  // opening tags — see the contract note above.
  for (const tag of THINKING_TAGS) {
    protected_ = protected_.replace(new RegExp(`</${tag}>`, 'gi'), '')
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    protected_ = protected_.replace(placeholder + i + '\x00', codeBlocks[i])
  }

  return protected_
}
