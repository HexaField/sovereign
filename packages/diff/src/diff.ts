// Core text diff

import { diffArrays } from 'diff'
import type { DiffHunk, DiffLine } from './types.js'

export function diffText(oldText: string, newText: string): DiffHunk[] {
  if (oldText === newText) return []

  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')

  const changes = diffArrays(oldLines, newLines)

  // Build a flat list of line entries with types
  interface LineEntry {
    type: 'add' | 'remove' | 'context'
    content: string
    oldLineNumber?: number
    newLineNumber?: number
  }

  const allLines: LineEntry[] = []
  let oldLineNum = 1
  let newLineNum = 1

  for (const change of changes) {
    for (const value of change.value) {
      if (change.added) {
        allLines.push({ type: 'add', content: value, newLineNumber: newLineNum++ })
      } else if (change.removed) {
        allLines.push({ type: 'remove', content: value, oldLineNumber: oldLineNum++ })
      } else {
        allLines.push({ type: 'context', content: value, oldLineNumber: oldLineNum++, newLineNumber: newLineNum++ })
      }
    }
  }

  // Group into hunks with context window of 3
  const CONTEXT = 3
  // Find ranges of changed lines
  const changedIndices: number[] = []
  for (let i = 0; i < allLines.length; i++) {
    if (allLines[i].type !== 'context') changedIndices.push(i)
  }

  if (changedIndices.length === 0) return []

  // Group changed indices into ranges, merging those within 2*CONTEXT of each other
  const groups: { start: number; end: number }[] = []
  let groupStart = changedIndices[0]
  let groupEnd = changedIndices[0]

  for (let i = 1; i < changedIndices.length; i++) {
    if (changedIndices[i] - groupEnd <= CONTEXT * 2) {
      groupEnd = changedIndices[i]
    } else {
      groups.push({ start: groupStart, end: groupEnd })
      groupStart = changedIndices[i]
      groupEnd = changedIndices[i]
    }
  }
  groups.push({ start: groupStart, end: groupEnd })

  // Convert groups to hunks with context
  const hunks: DiffHunk[] = []
  for (const group of groups) {
    const hunkStart = Math.max(0, group.start - CONTEXT)
    const hunkEnd = Math.min(allLines.length - 1, group.end + CONTEXT)

    const lines: DiffLine[] = []
    for (let i = hunkStart; i <= hunkEnd; i++) {
      const l = allLines[i]
      lines.push({
        type: l.type,
        content: l.content,
        ...(l.oldLineNumber !== undefined ? { oldLineNumber: l.oldLineNumber } : {}),
        ...(l.newLineNumber !== undefined ? { newLineNumber: l.newLineNumber } : {})
      })
    }

    // Calculate oldStart/newStart from first line in hunk
    const firstOld = lines.find((l) => l.oldLineNumber !== undefined)
    const firstNew = lines.find((l) => l.newLineNumber !== undefined)
    const oldStart = firstOld?.oldLineNumber ?? 1
    const newStart = firstNew?.newLineNumber ?? 1
    const oldLinesCount = lines.filter((l) => l.type === 'context' || l.type === 'remove').length
    const newLinesCount = lines.filter((l) => l.type === 'context' || l.type === 'add').length

    hunks.push({
      oldStart,
      oldLines: oldLinesCount,
      newStart,
      newLines: newLinesCount,
      lines
    })
  }

  return hunks
}
