// MessageOrigin — describes how an inbound chat message arrived at Sovereign.
//
// Used by the presence thread so the agent can choose how to reach back out:
// a voice transcription should be answered via TTS to the originating device,
// an AD4M mention should be answered with an AD4M reply, etc. See
// `plans/presence-thread-spec.md` (R2).

export type MessageModality = 'text' | 'voice' | 'ad4m' | 'cron' | 'webhook'

/** Modality-specific identifiers needed to route a response back to the
 *  surface the message came from. All fields are optional — only the
 *  ones relevant to the modality should be populated. */
export interface MessageOrigin {
  /** How the message arrived. */
  modality: MessageModality
  /** WS deviceId of the originating tab/device — used to target voice TTS
   *  back to the same surface, or to scope text replies. */
  deviceId?: string
  /** AD4M context for reply routing. */
  ad4m?: {
    perspectiveUuid: string
    /** The AD4M channel address (the parent that holds messages). */
    channelAddress: string
    /** The originating message node address (used by the reply for context). */
    messageAddress: string
  }
  /** Webhook source identifier — for future webhook gateways. */
  webhookSource?: string
}

/** Render a MessageOrigin as a compact one-line tag for the agent's context
 *  envelope. Keep this stable — PRESENCE.md teaches the agent to read it. */
export function renderOriginTag(origin: MessageOrigin): string {
  const parts: string[] = [`modality=${origin.modality}`]
  if (origin.deviceId) parts.push(`deviceId=${origin.deviceId}`)
  if (origin.ad4m) {
    parts.push(`perspectiveUuid=${origin.ad4m.perspectiveUuid}`)
    parts.push(`channelAddress=${origin.ad4m.channelAddress}`)
    parts.push(`messageAddress=${origin.ad4m.messageAddress}`)
  }
  if (origin.webhookSource) parts.push(`webhookSource=${origin.webhookSource}`)
  return parts.join(' ')
}
