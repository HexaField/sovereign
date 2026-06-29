// PresenceDigest — passive accumulator of one-line summaries from watched
// threads. When the presence thread next receives an inbound message, the
// chat module asks for the digest, prepends it, and clears the buffer.
//
// Cost model:
//   - No agent wake on watched-thread turns; just append to a capped buffer.
//   - Bounded memory: MAX_ENTRIES cap evicts oldest on overflow.
//   - Persisted between restarts so a daemon reload doesn't lose recent state.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { WatchStore } from './watch-store.js'

export interface DigestEntry {
  threadId: string
  /** Display label resolved at insertion time so the digest reads naturally
   *  even if the thread is later renamed/deleted. */
  threadLabel: string
  /** One-line summary derived from the assistant's last response. */
  summary: string
  /** Wall-clock when the source turn completed. */
  at: number
}

export interface PresenceDigest {
  /** Returns the accumulated digest as a single block of text ready to be
   *  prepended to the presence-thread user message; clears the buffer
   *  atomically. Returns null when empty. */
  take(): string | null
  /** Peek without clearing (used by tests + observability). */
  peek(): DigestEntry[]
  /** Stop listening on the bus. Idempotent. */
  dispose(): void
}

interface Deps {
  bus: EventBus
  watchStore: WatchStore
  /** Resolves a thread id to a display label (for rendering). */
  resolveLabel(threadId: string): string | undefined
  /** When set, store buffer state in this file across restarts. */
  persistFile?: string
  /** Max entries kept in memory. Oldest evicted on overflow. */
  maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 50

/** Reduce an assistant turn's content to a single short line. Strips
 *  thinking/markdown noise and clamps to ~120 chars. Exported for tests. */
export function summariseAssistantContent(content: string): string {
  const stripped = content
    .replace(/<antThinking>[\s\S]*?<\/antThinking>/g, '')
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/^[#>\-*\s]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!stripped) return ''
  // First sentence (up to . ! ? or end), capped at 120 chars.
  const firstSentenceMatch = stripped.match(/^.{1,120}?[.!?](?:\s|$)/)?.[0]?.trim()
  if (firstSentenceMatch) return firstSentenceMatch
  // No sentence boundary — truncate with ellipsis when the input is longer
  // than the cap so the caller can see truncation happened.
  if (stripped.length > 120) return stripped.slice(0, 117).trimEnd() + '...'
  return stripped
}

export function createPresenceDigest(deps: Deps): PresenceDigest {
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES
  const buffer: DigestEntry[] = []

  // Restore from disk if a persist path was provided.
  if (deps.persistFile) {
    try {
      const raw = fs.readFileSync(deps.persistFile, 'utf-8')
      const parsed = JSON.parse(raw) as DigestEntry[]
      if (Array.isArray(parsed)) {
        buffer.push(...parsed.slice(-maxEntries))
      }
    } catch {
      /* empty / corrupt — start fresh */
    }
  }

  let writeTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleWrite(): void {
    if (!deps.persistFile) return
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      flushNow()
    }, 500)
  }
  function flushNow(): void {
    if (!deps.persistFile) return
    try {
      fs.mkdirSync(path.dirname(deps.persistFile), { recursive: true })
      const tmp = deps.persistFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(buffer))
      fs.renameSync(tmp, deps.persistFile)
    } catch (err) {
      console.warn('[presence] digest persist failed:', (err as Error)?.message)
    }
  }

  function append(entry: DigestEntry): void {
    buffer.push(entry)
    while (buffer.length > maxEntries) buffer.shift()
    scheduleWrite()
  }

  const onTurnCompleted = (event: { payload: unknown }) => {
    const payload = event.payload as { threadId?: string; turn?: { role?: string; content?: string } }
    const threadId = payload?.threadId
    const turn = payload?.turn
    if (!threadId || !turn) return
    if (turn.role !== 'assistant') return
    if (!deps.watchStore.has(threadId)) return
    const summary = summariseAssistantContent(turn.content ?? '')
    if (!summary) return
    append({
      threadId,
      threadLabel: deps.resolveLabel(threadId) ?? threadId.slice(0, 8),
      summary,
      at: Date.now()
    })
  }
  const unsub = deps.bus.on('chat.turn.completed', onTurnCompleted)

  function formatAgo(ms: number): string {
    if (ms < 60_000) return 'just now'
    const mins = Math.round(ms / 60_000)
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.round(hrs / 24)}d ago`
  }

  let disposed = false
  return {
    take() {
      if (buffer.length === 0) return null
      const lines = ['[Thread activity since last interaction]']
      const now = Date.now()
      for (const e of buffer) {
        lines.push(`- ${e.threadLabel} (${formatAgo(now - e.at)}): ${e.summary}`)
      }
      lines.push('[End thread activity]')
      buffer.length = 0
      scheduleWrite()
      return lines.join('\n')
    },
    peek() {
      return [...buffer]
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsub()
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      flushNow()
    }
  }
}
