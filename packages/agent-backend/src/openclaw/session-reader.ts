// OpenClaw JSONL session reader — encapsulates ALL `~/.openclaw/` path
// resolution. No file outside this directory may know about these paths.

import fs from 'node:fs'
import path from 'node:path'
import { readAllMessages as sharedReadAll, readRecentMessages as sharedReadRecent } from '@sovereign/primitives'

/** Path-resolver bound to a specific OpenClaw deployment. */
export interface OpenClawPaths {
  sessionsDir: string
  sessionsJsonPath: string
  claudeProjectsDir: string
  openClawConfigPath: string
}

export function defaultOpenClawPaths(home: string = process.env.HOME || ''): OpenClawPaths {
  const sessionsDir = path.join(home, '.openclaw/agents/main/sessions')
  return {
    sessionsDir,
    sessionsJsonPath: path.join(sessionsDir, 'sessions.json'),
    claudeProjectsDir: path.join(home, '.claude/projects'),
    openClawConfigPath: path.join(home, '.openclaw/openclaw.json')
  }
}

/** Search `~/.claude/projects` for a claude-cli session JSONL file by ID. */
function findCliSessionFile(paths: OpenClawPaths, claudeCliSessionId: string): string | null {
  try {
    const projects = fs.readdirSync(paths.claudeProjectsDir)
    for (const project of projects) {
      const candidate = path.join(paths.claudeProjectsDir, project, `${claudeCliSessionId}.jsonl`)
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    /* `.claude/projects` may not exist */
  }
  return null
}

/**
 * Normalize a JSONL entry to a message object, handling both OpenClaw and
 * claude-cli formats. Used as the per-line normalizer for the shared JSONL reader.
 */
export function normalizeOpenClawEntry(entry: any): any | null {
  if (entry.type === 'message' && entry.message) {
    return entry.message
  }
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
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

/** Read sessions.json and find the session file path for a given session key. */
export function getSessionFilePath(paths: OpenClawPaths, sessionKey: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(paths.sessionsJsonPath, 'utf-8'))
    const meta = data[sessionKey]
    if (!meta?.sessionId) return null

    const claudeCliSessionId = meta.claudeCliSessionId
    if (claudeCliSessionId) {
      const cliFile = findCliSessionFile(paths, claudeCliSessionId)
      if (cliFile) {
        const ocFile = meta.sessionFile && fs.existsSync(meta.sessionFile) ? meta.sessionFile : null
        if (!ocFile) return cliFile
        const cliMtime = fs.statSync(cliFile).mtimeMs
        const ocMtime = fs.statSync(ocFile).mtimeMs
        if (cliMtime >= ocMtime) return cliFile
      }
    }

    if (meta.sessionFile && fs.existsSync(meta.sessionFile)) {
      return meta.sessionFile
    }

    const files = fs.readdirSync(paths.sessionsDir)
    const match = files.find((f) => f.startsWith(meta.sessionId) && f.endsWith('.jsonl'))
    return match ? path.join(paths.sessionsDir, match) : null
  } catch {
    return null
  }
}

/** Find ALL session JSONL files for a thread topic (including older/compacted sessions). */
export function getAllSessionFiles(paths: OpenClawPaths, sessionKey: string): string[] {
  try {
    let topic = sessionKey
    if (topic.includes(':thread:')) topic = topic.split(':thread:')[1]
    else if (topic.includes(':')) topic = topic.split(':').pop() || topic
    const topicSuffix = `-topic-${topic}.jsonl`

    const files = fs.readdirSync(paths.sessionsDir)
    const matching = files
      .filter((f) => f.endsWith(topicSuffix))
      .map((f) => ({
        path: path.join(paths.sessionsDir, f),
        mtime: fs.statSync(path.join(paths.sessionsDir, f)).mtimeMs
      }))
      .sort((a, b) => a.mtime - b.mtime)

    return matching.map((f) => f.path)
  } catch {
    return []
  }
}

/** Read messages from an OpenClaw session file using the OpenClaw normalizer. */
export function readAllMessages(filePath: string): any[] {
  return sharedReadAll(filePath, normalizeOpenClawEntry)
}

export function readRecentMessages(filePath: string, limit = 80): { messages: any[]; hasMore: boolean } {
  return sharedReadRecent(filePath, limit, normalizeOpenClawEntry)
}
