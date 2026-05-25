// Voice post-processor — §8.5.2.1

export interface VoicePostProcessor {
  process(agentResponse: string, context?: { threadKey?: string; lastUserMessage?: string }): Promise<string>
}

/** Strip fenced code blocks, replace with "a code snippet" */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, 'a code snippet')
}

/** Strip inline code */
function stripInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, '$1')
}

/** Replace Markdown tables with "a table with N rows" */
function stripTables(text: string): string {
  // Match table blocks: header row + separator + data rows
  return text.replace(/(?:^|\n)\|[^\n]+\|(?:\n\|[-: |]+\|)(?:\n\|[^\n]+\|)+/g, (match) => {
    // Count data rows (all rows minus header minus separator)
    const lines = match
      .trim()
      .split('\n')
      .filter((l) => l.trim().startsWith('|'))
    const separators = lines.filter((l) => /^\|[\s-:|]+\|$/.test(l.trim()))
    const dataRows = lines.length - 1 - separators.length // minus header minus separators
    return `a table with ${Math.max(dataRows, 1)} row${dataRows === 1 ? '' : 's'}`
  })
}

/** Replace URLs with "a link to [domain]" */
function replaceUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s)>\]]+/g, (url) => {
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '')
      return `a link to ${domain}`
    } catch {
      return 'a link'
    }
  })
}

/** Replace file paths with "a file called [basename]" */
function replaceFilePaths(text: string): string {
  // Match Unix-style paths and Windows-style paths
  return text.replace(/(?:(?:\/[\w.-]+){2,}|[A-Z]:\\(?:[\w.-]+\\)+[\w.-]+)/g, (p) => {
    const basename = p.split(/[/\\]/).filter(Boolean).pop() || p
    return `a file called ${basename}`
  })
}

/** Strip Markdown formatting: headers, bold, italic, links, images */
function stripMarkdown(text: string): string {
  let result = text
  // Headers
  result = result.replace(/^#{1,6}\s+/gm, '')
  // Images
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
  // Links: [text](url) → text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '$1')
  result = result.replace(/___(.+?)___/g, '$1')
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '$1')
  result = result.replace(/__(.+?)__/g, '$1')
  // Italic
  result = result.replace(/\*(.+?)\*/g, '$1')
  result = result.replace(/_(.+?)_/g, '$1')
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '$1')
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}\s*$/gm, '')
  // Blockquotes
  result = result.replace(/^>\s?/gm, '')
  return result
}

/** Collapse list markers */
function collapseListMarkers(text: string): string {
  return text.replace(/^[\s]*[-*+]\s+/gm, '').replace(/^[\s]*\d+\.\s+/gm, '')
}

/** Collapse excessive whitespace */
function collapseWhitespace(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function createRuleBasedPostProcessor(): VoicePostProcessor {
  return {
    async process(agentResponse: string): Promise<string> {
      let text = agentResponse
      // Order matters: code blocks first (before inline code/URL processing)
      text = stripCodeBlocks(text)
      text = stripTables(text)
      text = stripInlineCode(text)
      text = replaceUrls(text)
      text = replaceFilePaths(text)
      text = stripMarkdown(text)
      text = collapseListMarkers(text)
      text = collapseWhitespace(text)
      return text
    }
  }
}
