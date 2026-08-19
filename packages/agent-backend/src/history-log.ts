// Sovereign-owned append-only history log.
//
// Every message that passes through any agent backend gets appended here
// as a JSONL entry. This log is NEVER compacted, truncated, or modified
// after writing — it is the permanent source of truth for UI history
// display. Compaction only affects the LLM context (state.messages),
// not this log.
//
// Layout:
//   <dataDir>/agent-backend/history/<sessionKey>.jsonl
//
// Each line is a JSON-serialised ChatMessage (the same shape local-llm
// uses internally: OpenAI wire format + timestamp). This lets getHistory
// read directly from the log via the existing toGenericMessages →
// parseTurns pipeline without any format translation.

import fs from 'node:fs'
import path from 'node:path'

const HISTORY_SUBDIR = path.join('agent-backend', 'history')

/** Resolve the JSONL path for a session's history log. */
export function historyLogPath(dataDir: string, sessionKey: string): string {
  return path.join(dataDir, HISTORY_SUBDIR, `${encodeURIComponent(sessionKey)}.jsonl`)
}

/** Append a single message to the session's history log.
 *  Creates the directory and file on first call. Writes are synchronous
 *  (append to EOF) — safe for sequential message arrival within a turn.
 *  Partial writes from crashes are handled by the reader (malformed
 *  lines get skipped). */
export function appendToHistoryLog(dataDir: string, sessionKey: string, message: unknown): void {
  const filePath = historyLogPath(dataDir, sessionKey)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, JSON.stringify(message) + '\n')
  } catch (err) {
    console.warn(`[history-log] append failed for ${sessionKey}:`, err)
  }
}

/** Append multiple messages to the session's history log in one write. */
export function appendBatchToHistoryLog(dataDir: string, sessionKey: string, messages: unknown[]): void {
  if (messages.length === 0) return
  const filePath = historyLogPath(dataDir, sessionKey)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    fs.appendFileSync(filePath, lines)
  } catch (err) {
    console.warn(`[history-log] batch append failed for ${sessionKey}:`, err)
  }
}

/** Read all messages from the session's history log.
 *  Returns an array of raw message objects (same shape as ChatMessage).
 *  Skips malformed lines gracefully. Returns empty array when the log
 *  doesn't exist. */
export function readHistoryLog(dataDir: string, sessionKey: string): any[] {
  const filePath = historyLogPath(dataDir, sessionKey)
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const messages: any[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line))
      } catch {
        /* skip malformed line — partial write from crash */
      }
    }
    return messages
  } catch {
    return [] // file doesn't exist yet
  }
}

/** Check whether a history log exists for a session. */
export function historyLogExists(dataDir: string, sessionKey: string): boolean {
  return fs.existsSync(historyLogPath(dataDir, sessionKey))
}

/** Seed the history log from an existing messages array.
 *  Used during migration: takes the current state.messages and writes
 *  them all to the log as a baseline. Only writes if the log doesn't
 *  already exist (won't overwrite or duplicate). */
export function seedHistoryLog(dataDir: string, sessionKey: string, messages: unknown[]): void {
  if (historyLogExists(dataDir, sessionKey)) return
  appendBatchToHistoryLog(dataDir, sessionKey, messages)
}
