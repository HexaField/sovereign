// PresenceModule — single entry point bootstrap uses to wire presence.
//
// Composes: last-origin tracker, watch store, digest service, response tools.
// Exposes hooks the chat module and MCP server consume.
//
// Two threads play roles in the presence system (see plans/presence-thread-spec.md):
//   - 'internal' — the agent's stream-of-consciousness, where ambient inbound
//                  lands. Carries PRESENCE.md + memory.
//   - 'gateway'  — the user's text-chat surface. Normal Claude Code thread.
// Both are auto-created on first boot when missing.

import fs from 'node:fs'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { ThreadManager } from '@sovereign/threads'
import { createLastOriginTracker, type LastOriginTracker } from './last-origin.js'
import { createWatchStore, type WatchStore } from './watch-store.js'
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
  /** Watch-store handle exposed for the MCP tool layer. */
  watchStore: WatchStore
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

  function resolveThread(role: 'internal' | 'gateway'): string | null {
    if (cachedIds[role]) return cachedIds[role]
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

  const lastOrigin = createLastOriginTracker(deps.bus, internalThreadId)
  const watchStore = createWatchStore(dataDir)
  const digest = createPresenceDigest({
    bus: deps.bus,
    watchStore,
    resolveLabel: (threadId: string) => deps.threadManager.get(threadId)?.label,
    persistFile: path.join(dataDir, 'presence-digest.json')
  })

  const tools = createResponseTools({
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
    try {
      await deps.chat.sendToThread?.(id, text, {
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
    watchStore,
    digest,
    lastOrigin,
    tools,
    forwardToInternal,
    dispose() {
      digest.dispose()
      lastOrigin.dispose()
      watchStore.flush()
    }
  }
}
