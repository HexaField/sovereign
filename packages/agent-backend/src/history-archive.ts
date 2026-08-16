// History Archive — append-only preservation of full conversation history.
//
// Every destructive operation (context filter trimming, cozempic pruning,
// native JSONL pruning, strategy-based message removal) records what it
// changed BEFORE modifying the canonical data. The archive serves as the
// write-once source of truth for complete, unmodified message history.
//
// Archive layout:
//   <dataDir>/agent-backend/history-archive/
//     <backendSessionId>/
//       raw-tool-output.jsonl   — filter-trimmed tool outputs (append-only)
//       pre-recycle/
//         <timestamp>.jsonl     — full JSONL snapshots before recycle
//       pre-strategy/
//         <timestamp>.json      — full message array before strategy pruning

import fs from 'node:fs'
import path from 'node:path'

const ARCHIVE_SUBDIR = 'history-archive'

/** Resolve the archive directory for a session, creating it if needed. */
function archiveDir(dataDir: string, sessionId: string, ...sub: string[]): string {
  const dir = path.join(dataDir, 'agent-backend', ARCHIVE_SUBDIR, sessionId, ...sub)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// ── Claude Code: JSONL snapshot before recycle ─────────────────────────

/**
 * Copy the full JSONL file to the archive before cozempic or native
 * pruning modifies it. Each recycle creates a timestamped copy.
 *
 * @returns The archive file path, or null if the source doesn't exist.
 */
export function archiveJsonlBeforeRecycle(dataDir: string, sessionId: string, jsonlPath: string): string | null {
  if (!fs.existsSync(jsonlPath)) return null
  const dir = archiveDir(dataDir, sessionId, 'pre-recycle')
  const dest = path.join(dir, `${Date.now()}.jsonl`)
  try {
    fs.copyFileSync(jsonlPath, dest)
    return dest
  } catch (err) {
    console.warn('[history-archive] failed to archive JSONL before recycle:', err)
    return null
  }
}

// ── Claude Code: raw tool output before filter trims it ───────────────

/**
 * Append a raw tool output entry to the session's archive log.
 * Called by the context filter when it trims a tool result — the raw
 * (unfiltered) output gets preserved here before the trimmed version
 * enters the conversation.
 *
 * Format: one JSON object per line (JSONL), append-only.
 */
export function archiveRawToolOutput(
  dataDir: string,
  sessionId: string,
  entry: {
    ts: number
    toolName: string
    toolUseId: string
    rawChars: number
    trimmedChars: number
    raw: unknown
  }
): void {
  const dir = archiveDir(dataDir, sessionId)
  const file = path.join(dir, 'raw-tool-output.jsonl')
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch (err) {
    console.warn('[history-archive] failed to archive raw tool output:', err)
  }
}

// ── Local-LLM: message array snapshot before strategy pruning ─────────

/**
 * Write the full message array to the archive before context strategies
 * mutate it. Each strategy run creates a timestamped snapshot.
 *
 * @returns The archive file path, or null on failure.
 */
// ── Read archived history back for UI display ────────────────────────

export interface ArchiveSnapshot {
  /** Archive file path. */
  path: string
  /** Timestamp the snapshot was taken (extracted from filename). */
  timestamp: number
  /** File size in bytes. */
  size: number
}

/**
 * List all pre-recycle JSONL snapshots for a session, sorted
 * oldest-first. Returns empty array when no archives exist.
 */
export function listSessionArchives(dataDir: string, sessionId: string): ArchiveSnapshot[] {
  const dir = path.join(dataDir, 'agent-backend', ARCHIVE_SUBDIR, sessionId, 'pre-recycle')
  try {
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    return files
      .map((f) => {
        const ts = parseInt(f.replace('.jsonl', ''), 10)
        const fullPath = path.join(dir, f)
        const stat = fs.statSync(fullPath)
        return { path: fullPath, timestamp: isNaN(ts) ? 0 : ts, size: stat.size }
      })
      .sort((a, b) => a.timestamp - b.timestamp) // oldest first
  } catch {
    return []
  }
}

/**
 * Read an archived JSONL file and return its raw entries (unparsed but
 * JSON-parsed). The caller applies the same normalizer + parser it uses
 * for the live JSONL.
 *
 * @returns Array of raw JSONL entry objects from the archive file.
 */
export function readArchiveEntries(archivePath: string): any[] {
  try {
    const content = fs.readFileSync(archivePath, 'utf-8')
    const entries: any[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* skip malformed */
      }
    }
    return entries
  } catch {
    return []
  }
}

export function archiveMessagesBeforeStrategies(
  dataDir: string,
  sessionKey: string,
  messages: readonly unknown[]
): string | null {
  const dir = archiveDir(dataDir, sessionKey, 'pre-strategy')
  const dest = path.join(dir, `${Date.now()}.json`)
  try {
    fs.writeFileSync(dest, JSON.stringify(messages), 'utf-8')
    return dest
  } catch (err) {
    console.warn('[history-archive] failed to archive messages before strategies:', err)
    return null
  }
}
