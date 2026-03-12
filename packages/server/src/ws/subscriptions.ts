// Per-connection subscription tracking

export interface SubscriptionTracker {
  subscribe(deviceId: string, channels: string[], scope?: Record<string, string>): void
  unsubscribe(deviceId: string, channels: string[]): void
  getSubscriptions(deviceId: string): string[]
  getSubscribers(channel: string, scope?: Record<string, string>): string[]
  removeDevice(deviceId: string): string[]
}

export function createSubscriptionTracker(): SubscriptionTracker {
  throw new Error('not implemented')
}
