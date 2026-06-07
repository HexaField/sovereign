// Push notification manager — real web-push delivery with VAPID keys.
//
// Subscriptions are persisted to <dataDir>/notifications/push-subscriptions.json
// so a daemon restart doesn't lose every paired device. The file shape is a
// flat `{ <deviceId>: { endpoint, keys } }` map, written atomically via
// tmp + rename.

// `web-push` is a CommonJS module — `import *` resolves to a namespace whose
// `generateVAPIDKeys` etc. live on `.default`, not the top level. A default
// import gives us the actual exports object on Node ESM.
import webPush from 'web-push'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface PushSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushManager {
  subscribe(deviceId: string, subscription: PushSubscription): void
  unsubscribe(deviceId: string): void
  getSubscription(deviceId: string): PushSubscription | undefined
  allSubscriptions(): Map<string, PushSubscription>
  sendPush(deviceId: string, payload: unknown): Promise<void>
  /** Fire-and-forget broadcast to every subscriber. Stale 410/404 endpoints
   *  are pruned automatically. */
  sendAll(payload: unknown): Promise<void>
  /** Like sendAll but restricted to a specific device set. */
  sendToDevices(deviceIds: Iterable<string>, payload: unknown): Promise<void>
  getVapidPublicKey(): string | null
}

interface VapidKeys {
  publicKey: string
  privateKey: string
}

function loadOrGenerateVapidKeys(dataDir?: string): VapidKeys | null {
  if (!dataDir) return null

  const keyPath = join(dataDir, 'notifications', 'vapid-keys.json')

  try {
    if (existsSync(keyPath)) {
      const raw = readFileSync(keyPath, 'utf-8')
      const keys = JSON.parse(raw) as VapidKeys
      if (keys.publicKey && keys.privateKey) return keys
    }
  } catch {
    // Regenerate on corrupt file
  }

  try {
    const keys = webPush.generateVAPIDKeys()
    const vapidKeys: VapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey }
    const dir = dirname(keyPath)
    mkdirSync(dir, { recursive: true })
    writeFileSync(keyPath, JSON.stringify(vapidKeys, null, 2))
    return vapidKeys
  } catch {
    return null
  }
}

function subscriptionsFile(dataDir: string): string {
  return join(dataDir, 'notifications', 'push-subscriptions.json')
}

function loadSubscriptions(dataDir?: string): Map<string, PushSubscription> {
  const out = new Map<string, PushSubscription>()
  if (!dataDir) return out
  const file = subscriptionsFile(dataDir)
  if (!existsSync(file)) return out
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, PushSubscription>
    for (const [deviceId, sub] of Object.entries(raw)) {
      if (deviceId && sub?.endpoint && sub.keys?.p256dh && sub.keys?.auth) {
        out.set(deviceId, sub)
      }
    }
  } catch {
    /* tolerate corrupt file */
  }
  return out
}

function persistSubscriptions(dataDir: string, subs: Map<string, PushSubscription>): void {
  const file = subscriptionsFile(dataDir)
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(subs), null, 2))
  renameSync(tmp, file)
}

export const createPushManager = (dataDir?: string): PushManager => {
  const subscriptions = loadSubscriptions(dataDir)
  const sent: Array<{ deviceId: string; payload: unknown }> = []

  const vapidKeys = loadOrGenerateVapidKeys(dataDir)

  if (vapidKeys) {
    webPush.setVapidDetails('mailto:noreply@sovereign.local', vapidKeys.publicKey, vapidKeys.privateKey)
  }

  const persistIfPossible = (): void => {
    if (!dataDir) return
    try {
      persistSubscriptions(dataDir, subscriptions)
    } catch {
      /* non-fatal — in-memory state still correct */
    }
  }

  const subscribe = (deviceId: string, subscription: PushSubscription): void => {
    subscriptions.set(deviceId, subscription)
    persistIfPossible()
  }

  const unsubscribe = (deviceId: string): void => {
    if (subscriptions.delete(deviceId)) persistIfPossible()
  }

  const getSubscription = (deviceId: string): PushSubscription | undefined => {
    return subscriptions.get(deviceId)
  }

  const allSubscriptions = (): Map<string, PushSubscription> => {
    return new Map(subscriptions)
  }

  const sendOne = async (deviceId: string, sub: PushSubscription, payload: unknown): Promise<void> => {
    if (!vapidKeys) {
      sent.push({ deviceId, payload })
      return
    }
    try {
      await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 60 })
    } catch (err: any) {
      // Expired or invalid subscription — remove it
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        subscriptions.delete(deviceId)
        persistIfPossible()
      }
      // Network failures are silently ignored to avoid crashing callers
    }
  }

  const sendPush = async (deviceId: string, payload: unknown): Promise<void> => {
    const sub = subscriptions.get(deviceId)
    if (!sub) return
    await sendOne(deviceId, sub, payload)
  }

  const sendAll = async (payload: unknown): Promise<void> => {
    const entries = [...subscriptions.entries()]
    await Promise.all(entries.map(([id, sub]) => sendOne(id, sub, payload)))
  }

  const sendToDevices = async (deviceIds: Iterable<string>, payload: unknown): Promise<void> => {
    const ids = [...deviceIds]
    await Promise.all(
      ids
        .map((id) => [id, subscriptions.get(id)] as const)
        .filter((tuple): tuple is [string, PushSubscription] => Boolean(tuple[1]))
        .map(([id, sub]) => sendOne(id, sub, payload))
    )
  }

  const getVapidPublicKey = (): string | null => {
    return vapidKeys?.publicKey ?? null
  }

  return {
    subscribe,
    unsubscribe,
    getSubscription,
    allSubscriptions,
    sendPush,
    sendAll,
    sendToDevices,
    getVapidPublicKey
  }
}
