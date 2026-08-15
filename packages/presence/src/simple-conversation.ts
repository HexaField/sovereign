// Simple Conversation Store — tracks the human-level dialogue between the
// user and Hex on the presence gateway thread.
//
// Collects two sources:
//   1. User messages on the gateway thread (from `chat.message.sent`)
//   2. Hex's outbound replies (from `presence.reply` — reply_voice / reply_text)
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

// ── Module ─────────────────────────────────────────────────────────────

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

  // ── Hex's outbound replies (reply_voice / reply_text) ─────────────

  const offReply = bus.on('presence.reply', (event) => {
    const payload = event.payload as { modality?: string; text?: string }
    if (!payload?.text) return

    push({
      role: 'hex',
      text: payload.text,
      modality: payload.modality ?? 'text',
      timestamp: event.timestamp
    })
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
