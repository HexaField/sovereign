// Compact-boundary JSONL trimmer — prevents unbounded JSONL growth.
//
// Background: the Claude Code SDK appends every message to a per-session
// JSONL. When auto-compaction fires, it adds a `compact_boundary` system
// entry followed by a compacted summary user message; the old content stays
// in the file. cozempic's tool_result stripper handles early growth, but
// after 30–50 compactions the pre-boundary content — all stripped of tool
// results — can reach 50 MB while delivering zero additional context (the
// compacted summary already replaced it all).
//
// `trimJsonlToLastCompaction` reduces such a file by 95–97% while keeping
// the agent's full context intact: the compact_boundary + anchor entry +
// post-boundary content is everything the SDK needs to resume correctly.

import fs from 'node:fs'

/**
 * Truncate a JSONL to just the last `compact_boundary` entry, one anchor
 * entry, and everything that follows.
 *
 * The anchor entry is the message whose UUID equals the compact_boundary's
 * `logicalParentUuid` — the SDK resolves its UUID chain against it. Without
 * it, the compact_boundary has a dangling `logicalParentUuid`, which the SDK
 * may warn about. Everything else before the boundary delivers no additional
 * context: the compacted summary (first user message after the boundary)
 * already contains the full conversation history.
 *
 * Write path is atomic (write to `.trim-tmp`, then `rename`), so a crash
 * never leaves a half-written JSONL.
 *
 * Returns the number of bytes reclaimed (0 when no compact_boundary exists
 * or when the trimmed file would not be meaningfully smaller than the
 * original).
 */
export function trimJsonlToLastCompaction(filePath: string): number {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')
  const originalSize = raw.length

  // Find the last compact_boundary entry (scan from the end for speed).
  let lastCbIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue
    try {
      const e = JSON.parse(lines[i]) as Record<string, unknown>
      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        lastCbIdx = i
        break
      }
    } catch {
      /* skip invalid JSON */
    }
  }
  if (lastCbIdx < 0) return 0

  // Locate the anchor entry — the single pre-boundary message the SDK needs
  // for `logicalParentUuid` resolution.
  const cb = JSON.parse(lines[lastCbIdx]) as Record<string, unknown>
  const anchorUuid = typeof cb.logicalParentUuid === 'string' ? cb.logicalParentUuid : undefined

  let anchorIdx = -1
  if (anchorUuid) {
    for (let i = lastCbIdx - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue
      try {
        const e = JSON.parse(lines[i]) as Record<string, unknown>
        if (e.uuid === anchorUuid) {
          anchorIdx = i
          break
        }
      } catch {
        /* skip */
      }
    }
  }

  // Assemble: [anchor?] [compact_boundary … end]
  const kept: string[] = []
  if (anchorIdx >= 0) kept.push(lines[anchorIdx])
  for (let i = lastCbIdx; i < lines.length; i++) kept.push(lines[i])
  const newContent = kept.join('\n')
  if (newContent.length >= originalSize) return 0

  // Atomic write.
  const tmp = filePath + '.trim-tmp'
  fs.writeFileSync(tmp, newContent, 'utf-8')
  fs.renameSync(tmp, filePath)
  return originalSize - newContent.length
}
