import { createWsStore, type WsStore } from './ws-store.js'

// In non-DOM test environments (vitest `node`) the module graph can still
// pull this file through transitive imports (e.g. a feature module imports
// Header which imports wsStore). Eager `window.location` evaluation crashes
// those test suites with `ReferenceError: window is not defined`. Resolve
// the URL inside a guarded thunk so import is side-effect-free.

const HAS_WINDOW = typeof window !== 'undefined' && typeof window.location !== 'undefined'

const url = HAS_WINDOW
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
  : 'ws://localhost/ws' // unused in tests; createWsStore tolerates an unreachable URL

export const wsStore: WsStore = createWsStore({
  url,
  WebSocket: HAS_WINDOW ? (WebSocket as any) : undefined
})
