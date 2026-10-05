// Simple Conversation Store — tracks the human-level dialogue between the
// user and Hex, per thread.
//
// Collects three sources:
//   1. User messages (from `chat.message.sent`)
//   2. Hex's outbound replies (from `presence.reply` — reply_voice /
//      reply_text, or a voice summary). A reply without a threadId comes
//      from the presence tools and belongs to the gateway thread.
//   3. Assistant turns (from `chat.turn.completed`)
//
// Source 3 fills the gap left when the SDK responds directly on the gateway
// thread without going through the presence reply tools or voice pipeline.
// A 5-second grace window lets the voice-response summary (source 2) take
// priority for voice-originated messages — the spoken summary reads better
// than the raw markdown response. If no summary arrives, the stripped raw
// text appears instead.
//
// The result strips away internal reasoning, tool calls, and subagent work
// — just what was said between them. Persisted to disk so entries survive
// service restarts and rebuilds: the gateway thread in
// `simple-conversation.json`, every other thread in
// `simple-conversation/<threadId>.json`.
//
// LLM summaries cost a call per assistant turn, so only the gateway thread
// and threads someone has opened the simple view for (`open`) get them;
// other threads keep a truncated first paragraph. The first `open` of a
// thread with no entries backfills them from its history.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'

// ── Types ──────────────────────────────────────────────────────────────

export interface SimpleConversationEntry {
  role: 'user' | 'hex'
  text: string
  /** How the message arrived: 'text' (typed), 'voice' (spoken), 'ad4m'. */
  modality: string
  timestamp: string
}

export interface SimpleConversationConfig {
  /** The presence gateway thread id, or null when not yet provisioned. */
  gatewayThreadId: string | null
}

export interface SimpleConversationDeps {
  bus: EventBus
  config: () => SimpleConversationConfig
  /** Directory for the persistence files. When absent, the store runs
   *  in-memory only (useful for tests). */
  dataDir?: string
  /** When provided, text-mode assistant responses get summarised via LLM
   *  instead of truncated. Falls back to truncation on error or when
   *  absent. Uses the same prompt as the voice summary pipeline. */
  summarize?: (text: string) => Promise<string>
  /** A thread's past turns, oldest first — backfills its first `open`. */
  history?: (threadId: string) => Promise<HistoryTurn[]>
}

export interface HistoryTurn {
  role: string
  content: string
  /** Epoch milliseconds. */
  timestamp: number
  origin?: { modality?: string }
}

const MAX_ENTRIES = 200
const FILE_NAME = 'simple-conversation.json'
const THREAD_DIR = 'simple-conversation'
const WATCHED_FILE = 'simple-conversation-watched.json'
/** Grace period (ms) for the voice-response summary to replace a raw turn. */
const VOICE_GRACE_MS = 5000
/** Max chars for a text-mode hex entry before truncation. */
const TEXT_ENTRY_MAX_CHARS = 500

// ── Text stripping ────────────────────────────────────────────────────

/** Strip markdown formatting, code blocks, and tool artifacts from an
 *  assistant response so it reads as clean plain text in the simple
 *  conversation view. */
function stripToPlainText(raw: string): string {
  let text = raw
  // Remove XML-style thinking/artifact blocks
  text = text.replace(/<\/?(?:thinking|antml_thinking|artifact)[^>]*>/g, '')
  // Remove fenced code blocks (keep nothing)
  text = text.replace(/```[\s\S]*?```/g, '')
  // Remove inline code backticks (keep content)
  text = text.replace(/`([^`]+)`/g, '$1')
  // Convert markdown links to just text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  // Remove heading markers
  text = text.replace(/^#{1,6}\s*/gm, '')
  // Remove bold / italic / strikethrough markers
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
  text = text.replace(/~~([^~]+)~~/g, '$1')
  // Convert list bullets to plain text
  text = text.replace(/^\s*[-*+]\s+/gm, '• ')
  // Strip numbered list markers
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '')
  // Collapse excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/** Truncate a text-mode response to a concise first paragraph, capped at
 *  TEXT_ENTRY_MAX_CHARS. Keeps the simple conversation readable without
 *  dumping the full agent output. */
function truncateForSimpleView(text: string): string {
  // Take the first paragraph (split on double newline)
  const firstPara = text.split(/\n\n/)[0].trim()
  if (firstPara.length <= TEXT_ENTRY_MAX_CHARS) return firstPara
  // Truncate at last word boundary within the limit
  const cut = firstPara.lastIndexOf(' ', TEXT_ENTRY_MAX_CHARS)
  const end = cut > TEXT_ENTRY_MAX_CHARS * 0.5 ? cut : TEXT_ENTRY_MAX_CHARS
  return firstPara.slice(0, end) + '…'
}

/** Entries from a persisted file, with artifacts of older builds cleaned. */
function loadEntries(filePath: string): SimpleConversationEntry[] {
  const entries: SimpleConversationEntry[] = []
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SimpleConversationEntry[]
    if (!Array.isArray(parsed)) return entries
    let prevTs = ''
    let prevRole = ''
    for (const e of parsed) {
      if (!e || typeof e.text !== 'string' || typeof e.role !== 'string') continue
      // Drop placeholder entries from the pre-fix streaming path
      if (e.text === '(streaming summary)') continue
      // Deduplicate consecutive hex entries with the same timestamp
      // (artifact of the timer/reply race before the guard fix)
      if (e.role === 'hex' && prevRole === 'hex' && e.timestamp === prevTs) continue
      // Retroactively truncate overly long text entries from before
      // the truncation fix — keeps the persisted view consistent
      if (e.role === 'hex' && e.modality === 'text' && e.text.length > TEXT_ENTRY_MAX_CHARS) {
        e.text = truncateForSimpleView(e.text)
      }
      entries.push(e)
      prevTs = e.timestamp
      prevRole = e.role
    }
    // Trim to cap in case an old file exceeded the limit
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  } catch {
    /* no file or corrupt — start empty */
  }
  return entries
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, filePath)
}

export function createSimpleConversation(deps: SimpleConversationDeps) {
  const { bus, config, dataDir, summarize, history } = deps
  const threads = new Map<string, SimpleConversationEntry[]>()
  const gatewayId = (): string | null => config().gatewayThreadId

  // Thread ids are uuids; anything else stays in memory rather than
  // naming a file.
  const SAFE_ID = /^[\w.-]{1,128}$/
  function fileFor(threadId: string): string | null {
    if (!dataDir) return null
    if (threadId === gatewayId()) return path.join(dataDir, FILE_NAME)
    return SAFE_ID.test(threadId) ? path.join(dataDir, THREAD_DIR, `${threadId}.json`) : null
  }

  /** A thread's entries, loaded from disk on first use. */
  function entriesOf(threadId: string): SimpleConversationEntry[] {
    let list = threads.get(threadId)
    if (!list) {
      const file = fileFor(threadId)
      list = file ? loadEntries(file) : []
      threads.set(threadId, list)
    }
    return list
  }

  // Threads whose simple view someone opened: their turns get LLM summaries.
  const watchedFile = dataDir ? path.join(dataDir, WATCHED_FILE) : null
  const watched = new Set<string>()
  if (watchedFile) {
    try {
      const ids = JSON.parse(fs.readFileSync(watchedFile, 'utf-8'))
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') watched.add(id)
    } catch {
      /* none yet */
    }
  }

  // ── Debounced persistence ─────────────────────────────────────────────────

  const dirty = new Set<string>()
  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function schedulePersist(threadId: string): void {
    if (!dataDir) return
    dirty.add(threadId)
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      persistNow()
    }, 500)
  }

  function persistNow(): void {
    for (const threadId of dirty) {
      const file = fileFor(threadId)
      if (!file) continue
      try {
        writeJson(file, threads.get(threadId) ?? [])
      } catch (err) {
        console.warn('[simple-conversation] persist failed:', (err as Error)?.message)
      }
    }
    dirty.clear()
  }

  // ── User messages ─────────────────────────────────────────────────────────

  const offSent = bus.on('chat.message.sent', (event) => {
    const payload = event.payload as {
      threadId?: string
      text?: string
      origin?: { modality?: string }
    }
    if (!payload?.threadId || !payload?.text) return

    push(payload.threadId, {
      role: 'user',
      text: payload.text,
      modality: payload.origin?.modality ?? 'text',
      timestamp: event.timestamp
    })
  })

  // ── Deferred turn tracking ─────────────────────────────────────────
  //
  // When an assistant turn completes, we wait VOICE_GRACE_MS for a
  // `presence.reply` (voice-response summary) on that thread. If one
  // arrives, the summary wins and the raw turn gets discarded. If the timer
  // fires first, the stripped raw text gets pushed instead.

  const deferredTurns = new Map<string, { timer: ReturnType<typeof setTimeout>; text: string; timestamp: string }>()
  /** Guard against the timer/reply race: when the deferred timer fires
   *  first, it adds the threadId here so the subsequent presence.reply
   *  handler skips its own push (preventing a duplicate entry). */
  const timerFiredFor = new Set<string>()

  function cancelDeferred(threadId: string): void {
    const pending = deferredTurns.get(threadId)
    if (pending) {
      clearTimeout(pending.timer)
      deferredTurns.delete(threadId)
    }
  }

  // ── Hex's outbound replies (reply_voice / reply_text, voice summaries) ──

  const offReply = bus.on('presence.reply', (event) => {
    const payload = event.payload as { modality?: string; text?: string; threadId?: string }
    if (!payload?.text) return
    const threadId = payload.threadId ?? gatewayId()
    if (!threadId) return

    // Voice summary arrived — cancel any deferred raw turn so we use
    // the summary instead of the verbose markdown response.
    cancelDeferred(threadId)
    // Race guard: if the deferred timer already fired and pushed a
    // text entry, skip this push to avoid duplicates.
    if (timerFiredFor.delete(threadId)) return

    push(threadId, {
      role: 'hex',
      text: payload.text,
      modality: payload.modality ?? 'text',
      timestamp: event.timestamp
    })
  })

  // ── Assistant turns ───────────────────────────────────────────────────────
  //
  // Catches responses that never go through the reply tools or the voice
  // pipeline. Defers for VOICE_GRACE_MS so a voice summary can replace the
  // raw text.

  const offTurn = bus.on('chat.turn.completed', (event) => {
    const payload = event.payload as {
      threadId?: string
      turn?: { role?: string; content?: string }
    }
    if (!payload?.threadId) return
    if (payload.turn?.role !== 'assistant') return

    const rawText = payload.turn?.content ?? ''
    if (!rawText || rawText.trim().length < 3) return

    const stripped = stripToPlainText(rawText)
    if (!stripped) return

    // Cancel any previous deferred turn for this thread (shouldn't
    // happen in practice — turns arrive sequentially).
    cancelDeferred(payload.threadId)

    // Defer: give the voice-response summary pipeline time to emit a
    // `presence.reply`. If it does, `offReply` above cancels this timer.
    const threadId = payload.threadId
    const timer = setTimeout(() => {
      deferredTurns.delete(threadId)
      // Signal that the timer fired — the presence.reply handler checks
      // this to avoid pushing a duplicate voice entry.
      timerFiredFor.add(threadId)

      const truncated = (): void =>
        push(threadId, {
          role: 'hex',
          text: truncateForSimpleView(stripped),
          modality: 'text',
          timestamp: event.timestamp
        })

      // Threads in the simple view get a real summary; others truncate.
      if (summarize && (threadId === gatewayId() || watched.has(threadId))) {
        void summarize(stripped)
          .then((summary) => {
            if (!summary) return truncated()
            push(threadId, { role: 'hex', text: summary, modality: 'text', timestamp: event.timestamp })
          })
          .catch(truncated)
      } else {
        truncated()
      }
    }, VOICE_GRACE_MS)

    deferredTurns.set(payload.threadId, { timer, text: stripped, timestamp: event.timestamp })
  })

  // ── Deleted threads ───────────────────────────────────────────────────────

  const offDeleted = bus.on('thread.deleted', (event) => {
    const threadId = (event.payload as { threadId?: string })?.threadId
    if (!threadId || threadId === gatewayId()) return
    cancelDeferred(threadId)
    threads.delete(threadId)
    dirty.delete(threadId)
    const file = fileFor(threadId)
    if (file) fs.rmSync(file, { force: true })
    if (watched.delete(threadId)) persistWatched()
  })

  function persistWatched(): void {
    if (!watchedFile) return
    try {
      writeJson(watchedFile, [...watched])
    } catch (err) {
      console.warn('[simple-conversation] persist failed:', (err as Error)?.message)
    }
  }

  function push(threadId: string, entry: SimpleConversationEntry): void {
    const entries = entriesOf(threadId)
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)

    schedulePersist(threadId)

    // Emit for live WS push
    bus.emit({
      type: 'presence.simple-conversation.updated',
      timestamp: new Date().toISOString(),
      source: 'presence',
      payload: { threadId, entry, total: entries.length }
    })
  }

  /** Entries backfilled from a thread's history: user messages and the
   *  first paragraph of each assistant reply. */
  function fromHistory(turns: HistoryTurn[]): SimpleConversationEntry[] {
    const out: SimpleConversationEntry[] = []
    for (const t of turns) {
      const timestamp = new Date(t.timestamp).toISOString()
      if (t.role === 'user' && t.content.trim()) {
        out.push({ role: 'user', text: t.content, modality: t.origin?.modality ?? 'text', timestamp })
      } else if (t.role === 'assistant') {
        const stripped = stripToPlainText(t.content ?? '')
        if (stripped) out.push({ role: 'hex', text: truncateForSimpleView(stripped), modality: 'text', timestamp })
      }
    }
    return out.slice(-MAX_ENTRIES)
  }

  return {
    /** A thread's entries — the gateway thread's when none is named. */
    getEntries(threadId?: string): SimpleConversationEntry[] {
      const id = threadId ?? gatewayId()
      return id ? entriesOf(id).slice() : []
    },
    /** Someone opened a thread's simple view: from now on its turns get LLM
     *  summaries, and a thread with no entries yet gets its history. */
    async open(threadId: string): Promise<SimpleConversationEntry[]> {
      if (threadId !== gatewayId() && !watched.has(threadId)) {
        watched.add(threadId)
        persistWatched()
      }
      if (history && entriesOf(threadId).length === 0) {
        const backfill = fromHistory(await history(threadId).catch(() => []))
        const entries = entriesOf(threadId)
        // Live entries may have landed while the history loaded: keep them
        // after the older backfilled ones.
        const first = entries[0]?.timestamp
        const older = first ? backfill.filter((e) => e.timestamp < first) : backfill
        if (older.length > 0) {
          entries.unshift(...older)
          if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
          schedulePersist(threadId)
        }
      }
      return entriesOf(threadId).slice()
    },
    shutdown() {
      offSent()
      offReply()
      offTurn()
      offDeleted()
      // Cancel deferred turn timers
      for (const [, pending] of deferredTurns) clearTimeout(pending.timer)
      deferredTurns.clear()
      timerFiredFor.clear()
      // Flush pending writes before clearing
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      persistNow()
      threads.clear()
    }
  }
}

export type SimpleConversation = ReturnType<typeof createSimpleConversation>
