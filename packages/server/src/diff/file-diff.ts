// File diff via git (shells out to git diff)

import { execSync } from 'node:child_process'
import type { FileDiff, DiffHunk, DiffLine } from './types.js'

function parseGitDiffOutput(output: string): FileDiff[] {
  const files: FileDiff[] = []
  if (!output.trim()) return files

  // Split on diff headers
  const diffSections = output.split(/^diff --git /m).filter(Boolean)

  for (const section of diffSections) {
    const lines = section.split('\n')
    // Parse file paths from first line: a/path b/path
    const headerMatch = lines[0].match(/a\/(.+?) b\/(.+)/)
    if (!headerMatch) continue

    const oldPath = headerMatch[1]
    const newPath = headerMatch[2]

    // Detect binary
    if (section.includes('Binary files')) {
      const status =
        section.includes('/dev/null') && section.indexOf('/dev/null') < section.indexOf(' and ')
          ? ('added' as const)
          : section.includes('/dev/null') && section.indexOf('/dev/null') > section.indexOf(' and ')
            ? ('deleted' as const)
            : ('modified' as const)
      files.push({
        path: newPath,
        ...(oldPath !== newPath ? { oldPath } : {}),
        status,
        binary: true,
        hunks: [],
        additions: 0,
        deletions: 0
      })
      continue
    }

    // Determine status
    let status: FileDiff['status'] = 'modified'
    if (section.includes('new file mode')) status = 'added'
    else if (section.includes('deleted file mode')) status = 'deleted'
    else if (section.includes('rename from') || oldPath !== newPath) status = 'renamed'

    // Parse hunks
    const hunks: DiffHunk[] = []
    let additions = 0
    let deletions = 0

    const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    let currentHunk: DiffHunk | null = null
    let oldLine = 0
    let newLine = 0

    for (const line of lines) {
      const hunkMatch = line.match(hunkRegex)
      if (hunkMatch) {
        if (currentHunk) hunks.push(currentHunk)
        oldLine = parseInt(hunkMatch[1])
        newLine = parseInt(hunkMatch[3])
        currentHunk = {
          oldStart: oldLine,
          oldLines: parseInt(hunkMatch[2] ?? '1'),
          newStart: newLine,
          newLines: parseInt(hunkMatch[4] ?? '1'),
          lines: []
        }
        continue
      }

      if (!currentHunk) continue

      if (line.startsWith('+')) {
        const dl: DiffLine = { type: 'add', content: line.slice(1), newLineNumber: newLine++ }
        currentHunk.lines.push(dl)
        additions++
      } else if (line.startsWith('-')) {
        const dl: DiffLine = { type: 'remove', content: line.slice(1), oldLineNumber: oldLine++ }
        currentHunk.lines.push(dl)
        deletions++
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1),
          oldLineNumber: oldLine++,
          newLineNumber: newLine++
        })
      }
      // skip \ No newline at end of file and other markers
    }
    if (currentHunk) hunks.push(currentHunk)

    files.push({
      path: newPath,
      ...(status === 'renamed' && oldPath !== newPath ? { oldPath } : {}),
      status,
      binary: false,
      hunks,
      additions,
      deletions
    })
  }

  return files
}

export async function diffFile(projectPath: string, filePath: string, base: string, head: string): Promise<FileDiff> {
  const output = execSync(`git diff ${base} ${head} -- "${filePath}"`, {
    cwd: projectPath,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  })

  const files = parseGitDiffOutput(output)
  if (files.length === 0) {
    return {
      path: filePath,
      status: 'modified',
      binary: false,
      hunks: [],
      additions: 0,
      deletions: 0
    }
  }
  return files[0]
}

export async function diffWorking(projectPath: string, opts?: { staged?: boolean }): Promise<FileDiff[]> {
  const args = opts?.staged ? '--cached' : ''
  const output = execSync(`git diff ${args}`, {
    cwd: projectPath,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  })

  return parseGitDiffOutput(output)
}
