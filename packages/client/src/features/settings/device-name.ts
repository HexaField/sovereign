// Device name — a friendly label for this browser tab's WS connection
// (e.g. "Josh Phone"). Persisted to localStorage and mirrored to the
// server over ws.device-name so chat.ts can render "[voice:Name]" instead
// of a raw connection id, and the agent can reference the device by name
// instead of a random id.
//
// Display only — TTS routing always targets the connection's own
// deviceId (see ws/index.ts __sovereignDeviceId), never this name.
// Multiple tabs on one device share this localStorage value but hold
// distinct WS connections, so each tab announces the same name under a
// different deviceId.

import { createSignal, type Accessor } from 'solid-js'
import { wsStore } from '../../ws/index.js'

export const DEVICE_NAME_KEY = 'sovereign:deviceName'

function readStoredName(): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    return localStorage.getItem(DEVICE_NAME_KEY) ?? ''
  } catch {
    return ''
  }
}

const [_deviceName, _setDeviceName] = createSignal<string>(readStoredName())

export const deviceName: Accessor<string> = _deviceName

/** Returns true once the user names this device — gates the
 *  auto-open-settings prompt on first launch. */
export function hasDeviceName(): boolean {
  return readStoredName().trim().length > 0
}

function announce(name: string): void {
  wsStore.send({ type: 'ws.device-name', deviceName: name } as any)
}

/** Update the device name: write-through to localStorage, then announce
 *  it on the current WS connection. Pass an empty string to clear it. */
export function setDeviceName(name: string): void {
  const trimmed = name.trim()
  _setDeviceName(trimmed)
  if (typeof localStorage !== 'undefined') {
    try {
      if (trimmed) localStorage.setItem(DEVICE_NAME_KEY, trimmed)
      else localStorage.removeItem(DEVICE_NAME_KEY)
    } catch {
      /* storage unavailable (private mode) — the signal still holds the
       * value for the rest of this tab's session */
    }
  }
  if (trimmed) announce(trimmed)
}

/**
 * Announce the stored name on every WS connect/reconnect. The server
 * mints a fresh deviceId per connection, so a name learned before a
 * reload never reaches the new connection without this. Call once from
 * App.tsx onMount; returns a teardown function.
 */
export function initDeviceNameSync(): () => void {
  const announceStored = (): void => {
    const stored = readStoredName()
    if (stored) announce(stored)
  }
  // Covers the (unusual) case where the connection opened before this
  // ran. The common path — not yet connected — waits for the first
  // ws.reconnected event below, which fires on every open, including
  // the initial one, so the two paths never double-announce.
  if (wsStore.connected()) announceStored()
  return wsStore.on('ws.reconnected', announceStored)
}
