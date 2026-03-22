// Push notification manager — real web-push delivery with VAPID keys

import * as webPush from 'web-push'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
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

export const createPushManager = (dataDir?: string): PushManager => {
  const subscriptions = new Map<string, PushSubscription>()
  const sent: Array<{ deviceId: string; payload: unknown }> = []

  const vapidKeys = loadOrGenerateVapidKeys(dataDir)

  if (vapidKeys) {
    webPush.setVapidDetails(
      'mailto:noreply@sovereign.local',
      vapidKeys.publicKey,
      vapidKeys.privateKey
    )
  }

  const subscribe = (deviceId: string, subscription: PushSubscription): void => {
    subscriptions.set(deviceId, subscription)
  }

  const unsubscribe = (deviceId: string): void => {
    subscriptions.delete(deviceId)
  }

  const getSubscription = (deviceId: string): PushSubscription | undefined => {
    return subscriptions.get(deviceId)
  }

  const allSubscriptions = (): Map<string, PushSubscription> => {
    return new Map(subscriptions)
  }

  const sendPush = async (deviceId: string, payload: unknown): Promise<void> => {
    const sub = subscriptions.get(deviceId)
    if (!sub) return

    if (!vapidKeys) {
      // Fallback: in-memory record only
      sent.push({ deviceId, payload })
      return
    }

    try {
      await webPush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { TTL: 60 }
      )
    } catch (err: any) {
      // Expired or invalid subscription — remove it
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        subscriptions.delete(deviceId)
      }
      // Network failures are silently ignored to avoid crashing callers
    }
  }

  const getVapidPublicKey = (): string | null => {
    return vapidKeys?.publicKey ?? null
  }

  return { subscribe, unsubscribe, getSubscription, allSubscriptions, sendPush, getVapidPublicKey }
}
