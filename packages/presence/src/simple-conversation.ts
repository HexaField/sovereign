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
// service restarts and rebuilds, one file per thread in
// `simple-conversation/<threadId>.json`. The gateway's log from before
// threads had their own files (`simple-conversation.json`) moves into the
// gateway thread's file on first use.
//
// LLM summaries cost a call per assistant turn, so only the gateway thread
// and threads whose simple view was opened (`open`) in the last day get
// them; other threads keep a truncated first paragraph. The first `open`
// of a thread backfills it from its history.

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
  /** Set on envelope turns (cron, system events): not part of the dialogue. */
  kind?: unknown
}

const MAX_ENTRIES = 200
const LEGACY_GATEWAY_FILE = 'simple-conversation.json'
const THREAD_DIR = 'simple-conversation'
const WATCHED_FILE = 'simple-conversation-watched.json'
/** How long an `open` keeps a thread's turns summarised by the LLM. */
const WATCH_TTL_MS = 24 * 60 * 60 * 1000
/** Max chars for a user entry. */
const USER_ENTRY_MAX_CHARS = 2000
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

function capUserText(text: string): string {
  return text.length > USER_ENTRY_MAX_CHARS ? text.slice(0, USER_ENTRY_MAX_CHARS) + '…' : text
}

export function createSimpleConversation(deps: SimpleConversationDeps) {
  const { bus, config, dataDir, summarize, history } = deps
  const threads = new Map<string, SimpleConversationEntry[]>()
  const gatewayId = (): string | null => config().gatewayThreadId

  // Thread ids are uuids; anything else stays in memory rather than
  // naming a file.
  const SAFE_ID = /^[\w.-]{1,128}$/
  function fileFor(threadId: string): string | null {
    if (!dataDir || !SAFE_ID.test(threadId)) return null
    return path.join(dataDir, THREAD_DIR, `${threadId}.json`)
  }

  /** A thread's entries, loaded from disk on first use. */
  function entriesOf(threadId: string): SimpleConversationEntry[] {
    let list = threads.get(threadId)
    if (!list) {
      const file = fileFor(threadId)
      list = file ? loadEntries(file) : []
      threads.set(threadId, list)
      if (threadId === gatewayId() && file && !fs.existsSync(file)) adoptLegacyGatewayLog(list, threadId)
    }
    return list
  }

  /** Move the single-file gateway log of older builds into the gateway's own file. */
  function adoptLegacyGatewayLog(list: SimpleConversationEntry[], threadId: string): void {
    const legacy = dataDir ? path.join(dataDir, LEGACY_GATEWAY_FILE) : null
    if (!legacy || !fs.existsSync(legacy)) return
    list.push(...loadEntries(legacy))
    dirty.add(threadId)
    persistNow()
    try {
      fs.renameSync(legacy, `${legacy}.migrated`)
    } catch {
      /* the new file holds the entries; a leftover legacy file stays unread */
    }
  }

  // When each thread's simple view was last opened: such threads get LLM
  // summaries for WATCH_TTL_MS.
  const watchedFile = dataDir ? path.join(dataDir, WATCHED_FILE) : null
  const watched = new Map<string, number>()
  if (watchedFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(watchedFile, 'utf-8'))
      for (const [id, at] of Object.entries(saved ?? {})) if (typeof at === 'number') watched.set(id, at)
    } catch {
      /* none yet */
    }
  }
  const summarised = (threadId: string): boolean =>
    threadId === gatewayId() || Date.now() - (watched.get(threadId) ?? 0) < WATCH_TTL_MS

  function persistWatched(): void {
    if (!watchedFile) return
    try {
      writeJson(watchedFile, Object.fromEntries(watched))
    } catch (err) {
      console.warn('[simple-conversation] persist failed:', (err as Error)?.message)
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
      text: capUserText(payload.text),
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
   *  first, it adds the threadId here so a late presence.reply for the same
   *  turn skips its own push (preventing a duplicate entry). The next turn
   *  on the thread clears it. */
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

    // A new turn: the guard from an earlier turn whose reply never came
    // (typed turns, skipped summaries) must not swallow this one's.
    timerFiredFor.delete(payload.threadId)

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
      if (summarize && summarised(threadId)) {
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

  const deleted = new Set<string>()
  const offDeleted = bus.on('thread.deleted', (event) => {
    const threadId = (event.payload as { threadId?: string })?.threadId
    if (!threadId || threadId === gatewayId()) return
    deleted.add(threadId)
    cancelDeferred(threadId)
    threads.delete(threadId)
    dirty.delete(threadId)
    const file = fileFor(threadId)
    if (file) fs.rmSync(file, { force: true })
    if (watched.delete(threadId)) persistWatched()
  })

  function push(threadId: string, entry: SimpleConversationEntry): void {
    if (deleted.has(threadId)) return
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
   *  first paragraph of each assistant reply. Envelope turns (cron, system
   *  events) are not part of the dialogue. */
  function fromHistory(turns: HistoryTurn[]): SimpleConversationEntry[] {
    const out: SimpleConversationEntry[] = []
    for (const t of turns) {
      if (t.kind) continue
      const timestamp = new Date(t.timestamp).toISOString()
      if (t.role === 'user' && t.content.trim()) {
        out.push({ role: 'user', text: capUserText(t.content), modality: t.origin?.modality ?? 'text', timestamp })
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
    /** Someone opened a thread's simple view: its turns get LLM summaries
     *  for the next WATCH_TTL_MS, and its first open backfills its history. */
    async open(threadId: string): Promise<SimpleConversationEntry[]> {
      if (threadId === gatewayId()) return entriesOf(threadId).slice()
      const firstOpen = !watched.has(threadId)
      watched.set(threadId, Date.now())
      persistWatched()
      if (firstOpen && history) {
        const backfill = fromHistory(await history(threadId).catch(() => []))
        if (deleted.has(threadId)) return []
        const entries = entriesOf(threadId)
        // Entries recorded live before this first open stay; the backfill
        // adds what came before them, minus anything they already hold.
        const first = entries[0]?.timestamp
        const seen = new Set(entries.map((e) => `${e.role}\u0000${e.text}`))
        const older = backfill.filter((e) => (!first || e.timestamp < first) && !seen.has(`${e.role}\u0000${e.text}`))
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
