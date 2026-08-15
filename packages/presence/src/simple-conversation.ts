// Simple Conversation Store — tracks the human-level dialogue between the
// user and Hex on the presence gateway thread.
//
// Collects two sources:
//   1. User messages on the gateway thread (from `chat.message.sent`)
//   2. Hex's outbound replies (from `presence.reply` — reply_voice / reply_text)
//
// The result strips away internal reasoning, tool calls, and subagent work
// — just what was said between them. In-memory only; clears on restart
// (matches the conversation summary's ephemeral nature).

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
}

const MAX_ENTRIES = 200

// ── Module ─────────────────────────────────────────────────────────────

export function createSimpleConversation(deps: SimpleConversationDeps) {
  const { bus, config } = deps
  const entries: SimpleConversationEntry[] = []

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
      entries.length = 0
    }
  }
}

export type SimpleConversation = ReturnType<typeof createSimpleConversation>
