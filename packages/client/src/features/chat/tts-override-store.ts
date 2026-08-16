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
// state broadcast so every tab/device stays in sync — but only the device
// whose name matches the active override shows the unmuted icon.

import { createSignal, createMemo } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { WsStore } from '../../ws/ws-store.js'
import { deviceName } from '../settings/device-name.js'

// Raw server state — thread-level, not device-level.
const [ttsEnabled, setTtsEnabled] = createSignal(false)
const [ttsDeviceName, setTtsDeviceName] = createSignal<string | null>(null)

/** Derived: TTS override active AND routed to THIS device. */
export const ttsActiveHere: Accessor<boolean> = createMemo(() => {
  if (!ttsEnabled()) return false
  const target = ttsDeviceName()
  const local = deviceName()
  if (!target || !local) return false
  return target === local
})

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

/** Toggle TTS override for the current thread.
 *  - Active here → turn OFF (no TTS for anyone)
 *  - Not active here (off or on another device) → turn ON for this device */
export function toggleTtsOverride(): void {
  if (!wsRef || !threadIdRef) return
  const activeHere = ttsActiveHere()
  wsRef.send({
    type: 'voice.tts-override',
    threadId: threadIdRef,
    enabled: !activeHere
  } as any)
  // Optimistic update — server confirms via state broadcast
  if (activeHere) {
    setTtsEnabled(false)
    setTtsDeviceName(null)
  } else {
    setTtsEnabled(true)
    setTtsDeviceName(deviceName() || null)
  }
}

/** Reactive accessor: TTS override active for the thread (any device). */
export { ttsEnabled }

/** Reactive accessor: which device receives TTS audio (null = none). */
export { ttsDeviceName }
