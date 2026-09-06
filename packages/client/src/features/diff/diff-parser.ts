// Pure unified diff parser — zero dependencies, fully testable.

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'del' | 'context' | 'header'
  content: string
  oldLine?: number
  newLine?: number
}

export interface ParsedDiffFile {
  from: string
  to: string
  hunks: DiffHunk[]
  binary: boolean
  renamed: boolean
}

/**
 * Parse a unified diff string into structured file + hunk data.
 * Handles standard `git diff` output with multiple files.
 */
export function parseDiff(raw: string): ParsedDiffFile[] {
  if (!raw || !raw.trim()) return []

  const lines = raw.split('\n')
  const files: ParsedDiffFile[] = []
  let current: ParsedDiffFile | null = null
  let currentHunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // New file header
    if (line.startsWith('diff --git ')) {
      if (current) files.push(current)
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      current = {
        from: match?.[1] ?? '',
        to: match?.[2] ?? '',
        hunks: [],
        binary: false,
        renamed: false
      }
      currentHunk = null
      continue
    }

    if (!current) continue

    // Binary file marker
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true
      continue
    }

    // Rename detection
    if (line.startsWith('rename from ') || line.startsWith('similarity index ')) {
      current.renamed = true
      continue
    }

    // Skip index, --- and +++ header lines (metadata)
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1], 10)
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1
      const newStart = parseInt(hunkMatch[3], 10)
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1
      currentHunk = {
        header: hunkMatch[5]?.trim() ?? '',
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: []
      }
      current.hunks.push(currentHunk)
      oldLine = oldStart
      newLine = newStart
      continue
    }

    if (!currentHunk) continue

    // Diff content lines
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), newLine: newLine++ })
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++ })
    } else if (line.startsWith(' ') || line === '') {
      // Context line (or empty context line at end of hunk)
      currentHunk.lines.push({ type: 'context', content: line.slice(1), oldLine: oldLine++, newLine: newLine++ })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — add as a context marker
      currentHunk.lines.push({ type: 'header', content: line })
    }
  }

  if (current) files.push(current)
  return files
}

/** Count total additions across all hunks in a parsed diff. */
export function countAdditions(file: ParsedDiffFile): number {
  let n = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') n++
    }
  }
  return n
}

/** Count total deletions across all hunks in a parsed diff. */
export function countDeletions(file: ParsedDiffFile): number {
  let n = 0
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'del') n++
    }
  }
  return n
}
