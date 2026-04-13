// Agent Backend — Thinking Block Stripping

const THINKING_TAGS = ['think', 'thinking', 'thought', 'antThinking']

/**
 * Strip thinking blocks from text, preserving fenced code blocks.
 * Handles nested tags (outermost wins), unclosed tags (strip to end), and multiple blocks.
 */
export function stripThinkingBlocks(text: string): string {
  // First, protect fenced code blocks by replacing them with placeholders
  const codeBlocks: string[] = []
  const placeholder = '\x00CODE_BLOCK\x00'
  let protected_ = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match)
    return placeholder + (codeBlocks.length - 1) + '\x00'
  })

  // Strip each thinking tag type — run multiple passes to handle nesting
  let changed = true
  while (changed) {
    const before = protected_
    for (const tag of THINKING_TAGS) {
      // Handle matched pairs — non-greedy to avoid eating content between separate blocks
      protected_ = protected_.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi'), '')
    }
    changed = protected_ !== before
  }

  for (const tag of THINKING_TAGS) {
    // Handle unclosed tags (strip from opening tag to end of string)
    protected_ = protected_.replace(new RegExp(`<${tag}>[\\s\\S]*$`, 'gi'), '')
    // Clean up orphaned closing tags
    protected_ = protected_.replace(new RegExp(`</${tag}>`, 'gi'), '')
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    protected_ = protected_.replace(placeholder + i + '\x00', codeBlocks[i])
  }

  return protected_
}
