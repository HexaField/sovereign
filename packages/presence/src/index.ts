// @sovereign/presence — agent presence thread orchestration.
//
// NOTE: this package is distinct from @sovereign/thread-presence (which
// tracks WS device focus for push notifications). This one owns the
// two-thread presence system:
//   - 'gateway'  — user's primary interface (voice, text, direct work)
//   - 'internal' — peripheral awareness (external integrations, digests)
//
// The internal thread processes external/ambient signals and surfaces
// noteworthy items to the gateway via presence_reply_text. Direct work
// stays in the gateway (or purpose-built threads with subagents).
//
// See plans/presence-thread-spec.md for the spec.

export { createLastOriginTracker, type LastOriginTracker } from './last-origin.js'
export { createWatchStore, type WatchStore, type WatchEntry } from './watch-store.js'
export { createPresenceDigest, summariseAssistantContent, type PresenceDigest, type DigestEntry } from './digest.js'
export {
  createResponseTools,
  renderInboundEnvelope,
  type PresenceResponseTools,
  type ResponseToolsDeps,
  type VoiceSynth,
  type Ad4mPoster,
  type ChatTextSender,
  type WsBinaryDispatcher,
  type VoiceReplyResult,
  type Ad4mReplyResult,
  type TextReplyResult,
  type WebhookReplyResult
} from './response-tools.js'
export { createAd4mPoster } from './ad4m-poster.js'
export { createPresenceModule, type PresenceModule, type PresenceModuleDeps } from './module.js'
export { bootstrapKnowledgeGraph, type KnowledgeGraphBootstrapOpts } from './knowledge-graph.js'
