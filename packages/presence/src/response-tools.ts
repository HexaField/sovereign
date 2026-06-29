// Response tools — the only outbound surface from the presence thread.
//
// Each tool dispatches its own delivery; there is NO event-driven dispatcher
// subscribing to chat.turn.completed for the presence thread. See R4 + R5 in
// plans/presence-thread-spec.md.
//
// Stub behaviour for voice: the full voice backend (provider selection,
// streaming synthesis, wake-word) is covered by vui-voice-backend-spec.md.
// Until that lands, we fall back to a chat broadcast tagged `[voice-stub]`
// on the target deviceId's chat channel.

import type { MessageOrigin } from '@sovereign/core'
import { renderOriginTag } from '@sovereign/core'
import type { LastOriginTracker } from './last-origin.js'

export interface VoiceSynth {
  synthesize(text: string): Promise<{ audio: Buffer; durationMs: number }>
}

export interface WsBinaryDispatcher {
  /** Send a binary frame to a specific deviceId on the named WS channel. */
  sendBinaryTo?(deviceId: string, channel: string, payload: Buffer): boolean
  /** Send a JSON frame to a specific deviceId — used for voice-stub fallback. */
  sendTo?(deviceId: string, payload: Record<string, unknown>): boolean
}

export interface Ad4mPoster {
  /** Add a `has_child` link from a channel to a new message node carrying
   *  the body as a literal:string. Returns the new message node address. */
  postChildMessage(perspectiveUuid: string, channelAddress: string, body: string): Promise<{ messageAddress: string }>
}

export interface ChatTextSender {
  /** Post a chat turn into a thread as the presence agent — visible in
   *  history like any assistant reply. Used by `presence_reply_text`. */
  postAssistantTurn(threadId: string, content: string): void
  /** Optional. Forward text into another thread as a user-style inbound,
   *  carrying an origin so the receiving session can render the
   *  `[presence:inbound …]` envelope. Used by `presence_internal_send`
   *  (gateway → internal). */
  sendToThread?(threadId: string, text: string, origin: import('@sovereign/core').MessageOrigin): Promise<void> | void
}

export interface ResponseToolsDeps {
  lastOrigin: LastOriginTracker
  voice?: VoiceSynth
  ws?: WsBinaryDispatcher
  ad4m?: Ad4mPoster
  chat: ChatTextSender
  /** Returns the presence thread's id, or null when none is configured.
   *  Used as the default for `presence_reply_text`. */
  presenceThreadId(): string | null
}

export interface VoiceReplyResult {
  delivered: boolean
  deviceId: string | null
  /** True when delivered via the TTS audio path; false when the voice-stub
   *  fallback delivered the text only. */
  audio: boolean
  /** Optional reason string when delivery degraded or failed. */
  reason?: string
}

export interface Ad4mReplyResult {
  messageAddress: string | null
  delivered: boolean
  reason?: string
}

export interface TextReplyResult {
  delivered: boolean
  threadId: string | null
  reason?: string
}

export interface WebhookReplyResult {
  delivered: false
  reason: string
}

export interface PresenceResponseTools {
  reply_voice(text: string, opts?: { deviceId?: string }): Promise<VoiceReplyResult>
  reply_ad4m(text: string, opts?: { perspectiveUuid?: string; channelAddress?: string }): Promise<Ad4mReplyResult>
  reply_text(text: string, opts?: { threadId?: string }): Promise<TextReplyResult>
  reply_webhook(text: string, opts: { source: string }): Promise<WebhookReplyResult>
}

export function createResponseTools(deps: ResponseToolsDeps): PresenceResponseTools {
  function resolveOrigin(modality: MessageOrigin['modality']): MessageOrigin | null {
    return deps.lastOrigin.get(modality)
  }

  return {
    async reply_voice(text, opts) {
      const deviceId = opts?.deviceId ?? resolveOrigin('voice')?.deviceId ?? null
      if (!deviceId) {
        return { delivered: false, deviceId: null, audio: false, reason: 'no-target-device' }
      }
      // Full TTS path — only when both voice + ws binary support are present.
      if (deps.voice && deps.ws?.sendBinaryTo) {
        try {
          const { audio } = await deps.voice.synthesize(text)
          const sent = deps.ws.sendBinaryTo(deviceId, 'voice-tts', audio)
          if (sent) return { delivered: true, deviceId, audio: true }
          return { delivered: false, deviceId, audio: false, reason: 'device-not-connected' }
        } catch (err) {
          // Fall through to text-stub on synthesize failure.
          const reason = (err as Error)?.message ?? 'synth-failed'
          if (deps.ws?.sendTo) {
            const sent = deps.ws.sendTo(deviceId, { type: 'voice-stub', text, reason })
            if (sent) return { delivered: true, deviceId, audio: false, reason: `fallback:${reason}` }
          }
          return { delivered: false, deviceId, audio: false, reason }
        }
      }
      // Voice-stub fallback — pure JSON delivery so the client can render
      // "[voice-stub] …" in chat without actual TTS.
      if (deps.ws?.sendTo) {
        const sent = deps.ws.sendTo(deviceId, { type: 'voice-stub', text })
        if (sent) return { delivered: true, deviceId, audio: false, reason: 'voice-backend-not-configured' }
      }
      return { delivered: false, deviceId, audio: false, reason: 'no-delivery-surface' }
    },

    async reply_ad4m(text, opts) {
      const origin = resolveOrigin('ad4m')
      const perspectiveUuid = opts?.perspectiveUuid ?? origin?.ad4m?.perspectiveUuid
      const channelAddress = opts?.channelAddress ?? origin?.ad4m?.channelAddress
      if (!perspectiveUuid || !channelAddress) {
        return { messageAddress: null, delivered: false, reason: 'no-target-channel' }
      }
      if (!deps.ad4m) {
        return { messageAddress: null, delivered: false, reason: 'ad4m-not-wired' }
      }
      try {
        const { messageAddress } = await deps.ad4m.postChildMessage(perspectiveUuid, channelAddress, text)
        return { messageAddress, delivered: true }
      } catch (err) {
        return {
          messageAddress: null,
          delivered: false,
          reason: (err as Error)?.message ?? 'ad4m-post-failed'
        }
      }
    },

    async reply_text(text, opts) {
      const threadId = opts?.threadId ?? deps.presenceThreadId()
      if (!threadId) {
        return { delivered: false, threadId: null, reason: 'no-target-thread' }
      }
      deps.chat.postAssistantTurn(threadId, text)
      return { delivered: true, threadId }
    },

    async reply_webhook(text, opts) {
      // Surface exists so PRESENCE.md can reference it; full implementation
      // deferred until a webhook gateway lands. Touching args silences the
      // unused-parameter lint without obscuring intent.
      void text
      void opts.source
      return { delivered: false, reason: 'not-implemented' }
    }
  }
}

/** Render the inbound envelope rendered into the presence thread.
 *  Exposed for tests so the prepended text is verifiable. */
export function renderInboundEnvelope(origin: MessageOrigin, text: string): string {
  return `[presence:inbound ${renderOriginTag(origin)}]\n${text}`
}
