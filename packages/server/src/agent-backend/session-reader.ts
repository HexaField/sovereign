// Direct session JSONL file reader — bypasses gateway RPC for fast history loading

import fs from 'node:fs'
import path from 'node:path'

const SESSIONS_DIR = path.join(process.env.HOME || '', '.openclaw/agents/main/sessions')
const SESSIONS_JSON = path.join(SESSIONS_DIR, 'sessions.json')

/** Read sessions.json and find the session file path for a given session key */
export function getSessionFilePath(sessionKey: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf-8'))
    const meta = data[sessionKey]
    if (!meta?.sessionId) return null

    // Check sessionFile field first (exact path)
    if (meta.sessionFile && fs.existsSync(meta.sessionFile)) {
      return meta.sessionFile
    }

    // Fallback: find JSONL file by sessionId prefix
    const files = fs.readdirSync(SESSIONS_DIR)
    const match = files.find((f) => f.startsWith(meta.sessionId) && f.endsWith('.jsonl'))
    return match ? path.join(SESSIONS_DIR, match) : null
  } catch {
    return null
  }
}

/** Read last N message entries from a JSONL file efficiently by reading from end of file */
export function readRecentMessages(filePath: string, limit: number = 80): { messages: any[]; hasMore: boolean } {
  const CHUNK = 256 * 1024 // 256KB chunks
  const stat = fs.statSync(filePath)
  let pos = stat.size
  let accumulated = ''
  const allMessages: any[] = []

  const fd = fs.openSync(filePath, 'r')
  try {
    while (pos > 0) {
      const readStart = Math.max(0, pos - CHUNK)
      const readLen = pos - readStart
      const buf = Buffer.alloc(readLen)
      fs.readSync(fd, buf, 0, readLen, readStart)
      accumulated = buf.toString('utf-8') + accumulated
      pos = readStart

      // Count message lines seen so far — break early if we have enough
      // Over-count by checking for "type":"message" substring as a fast heuristic
      const roughCount = (accumulated.match(/"type"\s*:\s*"message"/g) || []).length
      if (roughCount > limit * 2) break
    }
  } finally {
    fs.closeSync(fd)
  }

  // Parse all lines, keep only messages
  const lines = accumulated.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type === 'message' && entry.message) {
        allMessages.push(entry.message)
      }
    } catch {
      /* skip malformed lines */
    }
  }

  const hasMore = allMessages.length > limit
  return {
    messages: allMessages.slice(-limit),
    hasMore
  }
}
