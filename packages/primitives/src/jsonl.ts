// Generic JSONL tail-read helpers — used by any backend that persists session
// history as newline-delimited JSON. Each backend brings its own `normalize`
// function to project a raw JSONL entry into a normalized ChatMessage record.

import fs from 'node:fs'

export type Normalizer = (entry: any) => any | null

/** Read all messages from a JSONL file using the supplied normalizer. */
export function readAllMessages(filePath: string, normalize: Normalizer): any[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const messages: any[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const msg = normalize(entry)
        if (msg) messages.push(msg)
      } catch {
        /* skip malformed lines */
      }
    }
    return messages
  } catch {
    return []
  }
}

/**
 * Read the last `limit` messages from a JSONL file, using a tail-first chunked
 * read for speed on large files.
 */
export function readRecentMessages(
  filePath: string,
  limit: number,
  normalize: Normalizer
): { messages: any[]; hasMore: boolean } {
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

      // Heuristic: stop early once we've seen well over the requested count.
      const roughCount = (accumulated.match(/"type"\s*:\s*"(?:message|user|assistant)"/g) || []).length
      if (roughCount > limit * 2) break
    }
  } finally {
    fs.closeSync(fd)
  }

  for (const line of accumulated.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line)
      const msg = normalize(entry)
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
