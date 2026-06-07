// Web Push registration + subscription. Owns the Service Worker lifecycle
// and the subscribe/unsubscribe handshake against the server.
//
// Permission flow:
//   1. SW registered on app boot (silent — no permission ask).
//   2. User clicks "Enable browser notifications" in Settings → we call
//      `requestPermission()` which prompts.
//   3. On grant, we subscribe via PushManager + POST the subscription to
//      `/api/notifications/push/subscribe` with our stable `deviceId`.
//   4. Disable → POST `/push/unsubscribe` and call subscription.unsubscribe().

import { createSignal } from 'solid-js'
import { getDeviceId } from './device-id.js'

export type PushPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export const [pushPermission, setPushPermission] = createSignal<PushPermission>('default')
export const [pushSubscribed, setPushSubscribed] = createSignal(false)

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  )
}

function refreshPermission(): void {
  if (!pushSupported()) {
    setPushPermission('unsupported')
    return
  }
  setPushPermission(Notification.permission as PushPermission)
}

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (registrationPromise) return registrationPromise
  refreshPermission()
  if (!('serviceWorker' in navigator)) {
    registrationPromise = Promise.resolve(null)
    return registrationPromise
  }
  registrationPromise = navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(async (reg) => {
      // Check whether we already have an active subscription on disk — keeps
      // the UI state honest after a reload without re-running the prompt.
      const sub = await reg.pushManager.getSubscription()
      setPushSubscribed(!!sub)
      return reg
    })
    .catch((err) => {
      console.error('[push] service worker registration failed', err)
      return null
    })
  return registrationPromise
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  // Allocate via a fresh ArrayBuffer so the resulting view's buffer type is
  // `ArrayBuffer` (not `ArrayBufferLike`), which is what `BufferSource`
  // requires for `pushManager.subscribe({ applicationServerKey })`.
  const buf = new ArrayBuffer(raw.length)
  const arr = new Uint8Array(buf)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr as Uint8Array<ArrayBuffer>
}

async function fetchVapidKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/notifications/vapid-public-key')
    if (!res.ok) return null
    const data = (await res.json()) as { publicKey?: string }
    return data.publicKey ?? null
  } catch {
    return null
  }
}

export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }
  const permission = await Notification.requestPermission()
  setPushPermission(permission as PushPermission)
  if (permission !== 'granted') return { ok: false, reason: permission }

  const reg = await registerServiceWorker()
  if (!reg) return { ok: false, reason: 'no-registration' }

  const vapid = await fetchVapidKey()
  if (!vapid) return { ok: false, reason: 'no-vapid' }

  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid)
    })
  }

  const deviceId = getDeviceId()
  const res = await fetch('/api/notifications/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceId,
      subscription: sub.toJSON()
    })
  })
  if (!res.ok) return { ok: false, reason: `subscribe-${res.status}` }
  setPushSubscribed(true)
  return { ok: true }
}

export async function disablePush(): Promise<void> {
  const reg = await registerServiceWorker()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    try {
      await sub.unsubscribe()
    } catch {
      /* ignore */
    }
  }
  try {
    await fetch('/api/notifications/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId() })
    })
  } catch {
    /* ignore */
  }
  setPushSubscribed(false)
}

/**
 * Ask the SW to close any outstanding notifications for `threadId`. Use this
 * from in-page handlers when the user reads / iterates on a thread — the
 * server-side push.sendAll(thread.clear) covers other devices.
 */
export function dismissThreadNotification(threadId: string): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.ready
    .then((reg) => {
      reg.active?.postMessage({ type: 'sovereign:dismiss-thread', threadId })
    })
    .catch(() => {
      /* ignore */
    })
}
