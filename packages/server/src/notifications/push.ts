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
}

export const createPushManager = (): PushManager => {
  const subscriptions = new Map<string, PushSubscription>()
  const sent: Array<{ deviceId: string; payload: unknown }> = []

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
    // Stub: in production, would use web-push library
    sent.push({ deviceId, payload })
  }

  return { subscribe, unsubscribe, getSubscription, allSubscriptions, sendPush }
}
