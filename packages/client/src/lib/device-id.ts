// Stable per-browser device identifier. Generated once on first call and
// persisted to localStorage so push subscriptions and presence state stay
// consistent across reloads. Mobile PWAs get their own ID per install.
//
// Distinct from the WS connection deviceId (which the server mints on every
// connect) — that one is transient and only matters within a session.

const STORAGE_KEY = 'sovereign:device-id'

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback — quality matters less than uniqueness within this device.
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

let cached: string | null = null

export function getDeviceId(): string {
  if (cached) return cached
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY)
    if (existing) {
      cached = existing
      return existing
    }
    const fresh = uuid()
    window.localStorage.setItem(STORAGE_KEY, fresh)
    cached = fresh
    return fresh
  } catch {
    // localStorage unavailable (private mode, embedded) — fall back to an
    // in-memory ID that lasts the lifetime of the tab.
    if (!cached) cached = uuid()
    return cached
  }
}
