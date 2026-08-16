// TTS override store — decouples TTS output from input modality.
//
// When the override activates, every assistant turn on the current thread
// triggers TTS routed to the device that toggled it on. Toggling off
// restores the default behaviour (TTS only for voice-originated messages).
//
// State flows:
//   - Client → Server: `voice.tts-override` WS message (toggle)
//   - Server → Client: `voice.tts-override.state` WS message (broadcast)
//   - REST:             GET /api/voice/tts-override?threadId= (query on connect)
//
// The toggle carries the device name implicitly — the server resolves it
// from the WS connection that sent the message. All clients receive the
// state broadcast, so every tab/device stays in sync.

import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'

const [ttsEnabled, setTtsEnabled] = createSignal(false)
const [ttsDeviceName, setTtsDeviceName] = createSignal<string | null>(null)

let wsRef: WsStore | null = null
let threadIdRef: string | null = null

/** Fetch current TTS override state from the server for a thread. */
async function fetchState(threadId: string): Promise<void> {
  try {
    const res = await fetch(`/api/voice/tts-override?threadId=${encodeURIComponent(threadId)}`)
    if (!res.ok) return
    const data = await res.json()
    // Only apply if still on the same thread (race guard)
    if (threadIdRef === threadId) {
      setTtsEnabled(data.enabled ?? false)
      setTtsDeviceName(data.deviceName ?? null)
    }
  } catch {
    // Endpoint may not exist on older builds — degrade silently
  }
}

/**
 * Bind the store to the WS connection, track thread changes, and listen
 * for state broadcasts. Call once at app init. Returns a cleanup function.
 */
export function initTtsOverrideStore(ws: WsStore, threadKey: Accessor<string>): () => void {
  wsRef = ws
  threadIdRef = threadKey()

  // Live push — all clients receive state changes from any toggle
  const offState = ws.on<{ type: string; threadId: string; enabled: boolean; deviceName: string | null }>(
    'voice.tts-override.state',
    (msg) => {
      if (msg.threadId === threadIdRef) {
        setTtsEnabled(msg.enabled)
        setTtsDeviceName(msg.deviceName)
      }
    }
  )

  // Fetch current state on init
  void fetchState(threadIdRef)

  // Track thread changes — fetch server state instead of blindly resetting
  let lastKey = threadKey()
  const pollTimer = setInterval(() => {
    const key = threadKey()
    if (key !== lastKey) {
      lastKey = key
      threadIdRef = key
      void fetchState(key)
    }
  }, 500)

  return () => {
    clearInterval(pollTimer)
    offState()
    setTtsEnabled(false)
    setTtsDeviceName(null)
  }
}

/** Toggle TTS override for the current thread. */
export function toggleTtsOverride(): void {
  if (!wsRef || !threadIdRef) return
  const next = !ttsEnabled()
  wsRef.send({
    type: 'voice.tts-override',
    threadId: threadIdRef,
    enabled: next
  } as any)
  // Optimistic update — server will confirm via state broadcast
  setTtsEnabled(next)
}

/** Reactive accessor: TTS override currently active for this thread. */
export { ttsEnabled }

/** Reactive accessor: which device receives TTS audio (null = unknown). */
export { ttsDeviceName }
