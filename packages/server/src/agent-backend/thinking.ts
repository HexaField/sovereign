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

  // Strip each thinking tag type
  for (const tag of THINKING_TAGS) {
    // Handle matched pairs — greedy to capture outermost when nested
    const matchedPattern = new RegExp(`<${tag}>[\\s\\S]*</${tag}>`, 'gi')
    protected_ = protected_.replace(matchedPattern, '')

    // Handle unclosed tags (strip from opening tag to end of string)
    const unclosedPattern = new RegExp(`<${tag}>[\\s\\S]*$`, 'gi')
    protected_ = protected_.replace(unclosedPattern, '')
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    protected_ = protected_.replace(placeholder + i + '\x00', codeBlocks[i])
  }

  return protected_
}
