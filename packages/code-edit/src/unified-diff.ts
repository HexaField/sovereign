import { structuredPatch } from 'diff'

/** Unified diff of two texts, hunk headers and lines only, capped at `maxLines`. */
export function unifiedDiff(before: string, after: string, maxLines = 150): string {
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 3 })
  const out: string[] = []
  for (const h of patch.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const line of h.lines) if (!line.startsWith('\\')) out.push(line)
  }
  if (out.length <= maxLines) return out.join('\n')
  return [...out.slice(0, maxLines), `… ${out.length - maxLines} more diff lines`].join('\n')
}
