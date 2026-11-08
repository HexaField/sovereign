// PresenceModule — single entry point bootstrap uses to wire presence.
//
// Composes: last-origin tracker, watch store, digest service, response tools.
// Exposes hooks the chat module and MCP server consume.
//
// Two threads play roles in the presence system (see plans/presence-thread-spec.md):
//   - 'gateway'  — the user's primary interface. Voice, text, and direct work
//                  happen here. Normal Claude Code thread.
//   - 'internal' — peripheral awareness. External integrations (AD4M, webhooks)
//                  and watched-thread digests land here. Carries PRESENCE.md + memory.
// Both are auto-created on first boot when missing, and again when the thread
// holding a role is archived (archiving clears the role).

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { ThreadManager } from '@sovereign/threads'
import { createLastOriginTracker, type LastOriginTracker } from './last-origin.js'
import { createPresenceDigest, type PresenceDigest } from './digest.js'
import {
  createResponseTools,
  type PresenceResponseTools,
  type VoiceSynth,
  type Ad4mPoster,
  type ChatTextSender,
  type WsBinaryDispatcher
} from './response-tools.js'

export interface PresenceModuleDeps {
  bus: EventBus
  threadManager: ThreadManager
  dataDir: string
  /** Voice TTS — optional; reply_voice falls back to text stub without it. */
  voice?: VoiceSynth
  /** WS handler for voice/binary delivery — optional. */
  ws?: WsBinaryDispatcher
  /** AD4M poster — optional; reply_ad4m returns ad4m-not-wired without it. */
  ad4m?: Ad4mPoster
  /** Chat text sender — required for reply_text + the gateway forward path. */
  chat: ChatTextSender
  /** When true (default), auto-create whichever of the two presence threads
   *  is missing on startup. */
  autoCreate?: boolean
  /** Membrane to assign to either auto-created presence thread. */
  autoCreateMembraneId?: string
  /** Label for the auto-created internal thread. Defaults to 'presence-internal'. */
  internalLabel?: string
  /** Label for the auto-created gateway thread. Defaults to 'presence'. */
  gatewayLabel?: string
}

export interface PresenceModule {
  /** Internal thread id (stream-of-consciousness). Null when not yet provisioned. */
  internalThreadId(): string | null
  /** Gateway thread id (user-facing text chat). Null when not yet provisioned. */
  gatewayThreadId(): string | null
  /** Digest accumulator + take/clear (sourced from watched-thread turns). */
  digest: PresenceDigest
  /** Last-origin-per-modality tracker (populated from inbound on the internal thread). */
  lastOrigin: LastOriginTracker
  /** Outbound tools (reply_voice / reply_ad4m / reply_text / reply_webhook).
   *  Only callable from the internal session; gating happens in the MCP layer. */
  tools: PresenceResponseTools
  /** Forward a text message into the internal thread as a `text`-modality
   *  inbound. Used by `presence_internal_send` (gateway-session tool) and by
   *  any future surface that wants to drop a user-typed message into Hex's
   *  internal stream. */
  forwardToInternal(text: string, opts?: { deviceId?: string }): Promise<{ delivered: boolean }>
  /** Tear down bus subscriptions + flush persistence. */
  dispose(): void
}

export function createPresenceModule(deps: PresenceModuleDeps): PresenceModule {
  const dataDir = deps.dataDir
  fs.mkdirSync(dataDir, { recursive: true })

  const cachedIds = { internal: null as string | null, gateway: null as string | null }

  /** The cached id while its thread still exists, is live, and holds the role. */
  function cachedLive(role: 'internal' | 'gateway'): string | null {
    const id = cachedIds[role]
    if (!id) return null
    const thread = deps.threadManager.get(id)
    if (thread && !thread.archived && thread.presence === role) return id
    cachedIds[role] = null
    return null
  }

  function resolveThread(role: 'internal' | 'gateway'): string | null {
    const cached = cachedLive(role)
    if (cached) return cached
    // The thread manager allows one live thread per role, so this never duplicates.
    const existing = deps.threadManager.getPresenceThread(role)
    if (existing) {
      cachedIds[role] = existing.id
      return cachedIds[role]
    }
    if (deps.autoCreate === false) return null
    try {
      const thread = deps.threadManager.create({
        label: role === 'internal' ? (deps.internalLabel ?? 'presence-internal') : (deps.gatewayLabel ?? 'presence'),
        membraneId: deps.autoCreateMembraneId,
        presence: role
      })
      cachedIds[role] = thread.id
      return cachedIds[role]
    } catch (err) {
      console.warn(`[presence] auto-create ${role} failed:`, (err as Error)?.message)
      return null
    }
  }

  function internalThreadId(): string | null {
    return resolveThread('internal')
  }
  function gatewayThreadId(): string | null {
    return resolveThread('gateway')
  }

  // Trigger lookups/creates eagerly so the rest of the wiring sees both ids.
  internalThreadId()
  gatewayThreadId()

  // Archiving a presence thread clears its role. Put a fresh thread in its
  // place right away, so voice, replies and mentions keep a live target and the
  // user gets a new main chat without a restart. A role cleared by an update is
  // only dropped from the cache: whoever cleared it may be handing it to another
  // thread, so the next lookup resolves it.
  const offDeleted = deps.bus.on('thread.deleted', (event) => {
    const id = (event.payload as { threadId?: string } | undefined)?.threadId
    for (const role of ['internal', 'gateway'] as const) {
      if (id && cachedIds[role] === id) resolveThread(role)
    }
  })
  const offUpdated = deps.bus.on('thread.updated', (event) => {
    const id = (event.payload as { threadId?: string } | undefined)?.threadId
    for (const role of ['internal', 'gateway'] as const) {
      if (id && cachedIds[role] === id) cachedLive(role)
    }
  })

  const lastOrigin = createLastOriginTracker(deps.bus, internalThreadId)
  const digest = createPresenceDigest({
    bus: deps.bus,
    resolveLabel: (threadId: string) => deps.threadManager.get(threadId)?.label,
    persistFile: path.join(dataDir, 'presence-digest.json')
  })

  const tools = createResponseTools({
    bus: deps.bus,
    lastOrigin,
    voice: deps.voice,
    ws: deps.ws,
    ad4m: deps.ad4m,
    chat: deps.chat,
    // reply_text defaults to the gateway thread so the user sees the reply
    // in their normal chat surface — not buried in the internal monologue.
    presenceThreadId: gatewayThreadId
  })

  async function forwardToInternal(text: string, opts?: { deviceId?: string }): Promise<{ delivered: boolean }> {
    const id = internalThreadId()
    if (!id) return { delivered: false }
    if (!deps.chat.sendToThread) return { delivered: false }
    try {
      await deps.chat.sendToThread(id, text, {
        modality: 'text',
        ...(opts?.deviceId ? { deviceId: opts.deviceId } : {})
      })
      return { delivered: true }
    } catch (err) {
      console.warn('[presence] forwardToInternal failed:', (err as Error)?.message)
      return { delivered: false }
    }
  }

  return {
    internalThreadId,
    gatewayThreadId,
    digest,
    lastOrigin,
    tools,
    forwardToInternal,
    dispose() {
      offDeleted()
      offUpdated()
      digest.dispose()
      lastOrigin.dispose()
    }
  }
}
