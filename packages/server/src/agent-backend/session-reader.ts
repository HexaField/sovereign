// Direct session JSONL file reader — bypasses gateway RPC for fast history loading

import fs from 'node:fs'
import path from 'node:path'

const SESSIONS_DIR = path.join(process.env.HOME || '', '.openclaw/agents/main/sessions')
const SESSIONS_JSON = path.join(SESSIONS_DIR, 'sessions.json')
const CLAUDE_PROJECTS_DIR = path.join(process.env.HOME || '', '.claude/projects')

/** Search ~/.claude/projects for a claude-cli session JSONL file by ID */
function findCliSessionFile(claudeCliSessionId: string): string | null {
  try {
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR)
    for (const project of projects) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, project, `${claudeCliSessionId}.jsonl`)
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    // .claude/projects may not exist
  }
  return null
}

/** Read sessions.json and find the session file path for a given session key */
export function getSessionFilePath(sessionKey: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_JSON, 'utf-8'))
    const meta = data[sessionKey]
    if (!meta?.sessionId) return null

    // If session uses claude-cli, prefer the live CLI JSONL when it's newer
    const claudeCliSessionId = meta.claudeCliSessionId
    if (claudeCliSessionId) {
      const cliFile = findCliSessionFile(claudeCliSessionId)
      if (cliFile) {
        const ocFile = meta.sessionFile && fs.existsSync(meta.sessionFile) ? meta.sessionFile : null
        if (!ocFile) return cliFile
        const cliMtime = fs.statSync(cliFile).mtimeMs
        const ocMtime = fs.statSync(ocFile).mtimeMs
        if (cliMtime >= ocMtime) return cliFile
      }
    }

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

/** Find ALL session JSONL files for a thread topic (including older/compacted sessions) */
export function getAllSessionFiles(sessionKey: string): string[] {
  try {
    // Extract topic from session key: agent:main:thread:companion-intelligence → companion-intelligence
    let topic = sessionKey
    if (topic.includes(':thread:')) topic = topic.split(':thread:')[1]
    else if (topic.includes(':')) topic = topic.split(':').pop() || topic
    const topicSuffix = `-topic-${topic}.jsonl`

    const files = fs.readdirSync(SESSIONS_DIR)
    const matching = files
      .filter((f) => f.endsWith(topicSuffix))
      .map((f) => ({
        path: path.join(SESSIONS_DIR, f),
        mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs
      }))
      .sort((a, b) => a.mtime - b.mtime) // oldest first

    return matching.map((f) => f.path)
  } catch {
    return []
  }
}

/** Normalize a JSONL entry to a message object, handling both OpenClaw and claude-cli formats */
function normalizeEntry(entry: any): any | null {
  if (entry.type === 'message' && entry.message) {
    // OpenClaw format: {type:"message", message:{role, content, timestamp, ...}}
    return entry.message
  }
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    // Claude CLI format: {type:"user"|"assistant", message:{role, content}, timestamp:"ISO", ...}
    const msg = { ...entry.message }
    if (!msg.timestamp && entry.timestamp) {
      msg.timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : entry.timestamp
    } else if (typeof msg.timestamp === 'string') {
      msg.timestamp = Date.parse(msg.timestamp)
    }
    return msg
  }
  return null
}

/** Read messages from an older session file (for "load more" across session boundaries) */
export function readAllMessages(filePath: string): any[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const messages: any[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const msg = normalizeEntry(entry)
        if (msg) messages.push(msg)
      } catch {
        /* skip */
      }
    }
    return messages
  } catch {
    return []
  }
}
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
      // Over-count by checking for "type":"message"|"user"|"assistant" as a fast heuristic
      const roughCount = (accumulated.match(/"type"\s*:\s*"(?:message|user|assistant)"/g) || []).length
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
      const msg = normalizeEntry(entry)
      if (msg) allMessages.push(msg)
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
