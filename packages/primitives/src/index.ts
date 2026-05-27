// Public surface of @sovereign/primitives — shared low-level utilities
// consumed across the agent-backend layer and beyond. No deps on any other
// @sovereign/* package except @sovereign/core (types only).

export { createBackendEmitter, type BackendEmitter } from './event-emitter.js'
export * from './jsonl.js'
export * from './parse-turns.js'
export { stripThinkingBlocks } from './thinking.js'
export { createSessionsRegistry } from './sessions-registry.js'
export type { SessionsRegistry, ThreadSessionRecord } from './sessions-registry.js'
export { createWriteThroughFile } from './write-through-file.js'
export type { WriteThroughFile, WriteThroughFileOptions } from './write-through-file.js'
export { createWriteThroughStore } from './write-through-store.js'
export type { WriteThroughStore } from './write-through-store.js'
export type { WriteThroughStoreOptions } from './write-through-store.js'
export { createWsHandler } from './handler.js'
export type { WsHandler, WsLike } from './handler.js'
export { encodeBinaryFrame, decodeBinaryFrame, createBinaryChannelRegistry } from './binary.js'
export { createSubscriptionTracker } from './subscriptions.js'
export type { SubscriptionEntry, SubscriptionTracker } from './subscriptions.js'
