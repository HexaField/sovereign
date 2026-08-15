// Simple Conversation Store — tracks the human-level dialogue between the
// user and Hex on the presence gateway thread.
//
// Collects three sources:
//   1. User messages on the gateway thread (from `chat.message.sent`)
//   2. Hex's outbound replies (from `presence.reply` — reply_voice / reply_text)
//   3. Assistant turns on the gateway thread (from `chat.turn.completed`)
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
// service restarts and rebuilds.

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
  /** Directory for the persistence file. When absent, the store runs
   *  in-memory only (useful for tests). */
  dataDir?: string
}

const MAX_ENTRIES = 200
const FILE_NAME = 'simple-conversation.json'
/** Grace period (ms) for the voice-response summary to replace a raw turn. */
const VOICE_GRACE_MS = 5000

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

export function createSimpleConversation(deps: SimpleConversationDeps) {
  const { bus, config, dataDir } = deps
  const filePath = dataDir ? path.join(dataDir, FILE_NAME) : null
  const entries: SimpleConversationEntry[] = []

  // ── Load from disk ────────────────────────────────────────────────

  if (filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as SimpleConversationEntry[]
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (e && typeof e.text === 'string' && typeof e.role === 'string') {
            entries.push(e)
          }
        }
        // Trim to cap in case an old file exceeded the limit
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
      }
    } catch {
      /* no file or corrupt — start empty */
    }
  }

  // ── Debounced persistence ─────────────────────────────────────────

  let writeTimer: ReturnType<typeof setTimeout> | null = null

  function schedulePersist(): void {
    if (!filePath || writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      persistNow()
    }, 500)
  }

  function persistNow(): void {
    if (!filePath) return
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmp = filePath + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(entries))
      fs.renameSync(tmp, filePath)
    } catch (err) {
      console.warn('[simple-conversation] persist failed:', (err as Error)?.message)
    }
  }

  // ── User messages on the gateway thread ───────────────────────────

  const offSent = bus.on('chat.message.sent', (event) => {
    const payload = event.payload as {
      threadId?: string
      text?: string
      origin?: { modality?: string }
    }
    if (!payload?.threadId || !payload?.text) return

    const cfg = config()
    if (!cfg.gatewayThreadId || payload.threadId !== cfg.gatewayThreadId) return

    const modality = payload.origin?.modality ?? 'text'
    push({
      role: 'user',
      text: payload.text,
      modality,
      timestamp: event.timestamp
    })
  })

  // ── Deferred turn tracking ─────────────────────────────────────────
  //
  // When a gateway assistant turn completes, we wait VOICE_GRACE_MS for
  // a `presence.reply` (voice-response summary). If one arrives, the
  // summary wins and the raw turn gets discarded. If the timer fires
  // first, the stripped raw text gets pushed instead.

  const deferredTurns = new Map<string, { timer: ReturnType<typeof setTimeout>; text: string; timestamp: string }>()

  function cancelDeferred(threadId: string): void {
    const pending = deferredTurns.get(threadId)
    if (pending) {
      clearTimeout(pending.timer)
      deferredTurns.delete(threadId)
    }
  }

  // ── Hex's outbound replies (reply_voice / reply_text) ─────────────

  const offReply = bus.on('presence.reply', (event) => {
    const payload = event.payload as { modality?: string; text?: string }
    if (!payload?.text) return

    // Voice summary arrived — cancel any deferred raw turn so we use
    // the summary instead of the verbose markdown response.
    const cfg = config()
    if (cfg.gatewayThreadId) cancelDeferred(cfg.gatewayThreadId)

    push({
      role: 'hex',
      text: payload.text,
      modality: payload.modality ?? 'text',
      timestamp: event.timestamp
    })
  })

  // ── Assistant turns on the gateway thread ─────────────────────────
  //
  // Catches responses the SDK produces directly on the gateway thread
  // (text-originated messages that never go through the reply tools or
  // voice pipeline). Defers for VOICE_GRACE_MS so a voice summary can
  // replace the raw text.

  const offTurn = bus.on('chat.turn.completed', (event) => {
    const payload = event.payload as {
      threadId?: string
      turn?: { role?: string; content?: string }
    }
    if (!payload?.threadId) return
    if (payload.turn?.role !== 'assistant') return

    const cfg = config()
    if (!cfg.gatewayThreadId || payload.threadId !== cfg.gatewayThreadId) return

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
      push({
        role: 'hex',
        text: stripped,
        modality: 'text',
        timestamp: event.timestamp
      })
    }, VOICE_GRACE_MS)

    deferredTurns.set(payload.threadId, { timer, text: stripped, timestamp: event.timestamp })
  })

  function push(entry: SimpleConversationEntry): void {
    entries.push(entry)
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)

    schedulePersist()

    // Emit for live WS push
    bus.emit({
      type: 'presence.simple-conversation.updated',
      timestamp: new Date().toISOString(),
      source: 'presence',
      payload: { entry, total: entries.length }
    })
  }

  return {
    getEntries(): SimpleConversationEntry[] {
      return entries.slice()
    },
    shutdown() {
      offSent()
      offReply()
      offTurn()
      // Cancel deferred turn timers
      for (const [, pending] of deferredTurns) clearTimeout(pending.timer)
      deferredTurns.clear()
      // Flush pending writes before clearing
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      persistNow()
      entries.length = 0
    }
  }
}

export type SimpleConversation = ReturnType<typeof createSimpleConversation>
