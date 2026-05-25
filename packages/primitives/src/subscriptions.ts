// Per-connection subscription tracking

export interface SubscriptionEntry {
  channel: string
  scope?: Record<string, string>
}

export interface SubscriptionTracker {
  subscribe(deviceId: string, channels: string[], scope?: Record<string, string>): void
  unsubscribe(deviceId: string, channels: string[]): void
  getSubscriptions(deviceId: string): string[]
  getSubscribers(channel: string, scope?: Record<string, string>): string[]
  removeDevice(deviceId: string): string[]
}

export function createSubscriptionTracker(): SubscriptionTracker {
  // deviceId -> array of subscription entries
  const subs = new Map<string, SubscriptionEntry[]>()

  const subscribe = (deviceId: string, channels: string[], scope?: Record<string, string>): void => {
    if (!subs.has(deviceId)) subs.set(deviceId, [])
    const entries = subs.get(deviceId)!
    for (const channel of channels) {
      // Avoid duplicates for same channel+scope
      const exists = entries.some((e) => e.channel === channel && JSON.stringify(e.scope) === JSON.stringify(scope))
      if (!exists) {
        entries.push({ channel, scope })
      }
    }
  }

  const unsubscribe = (deviceId: string, channels: string[]): void => {
    const entries = subs.get(deviceId)
    if (!entries) return
    const set = new Set(channels)
    subs.set(
      deviceId,
      entries.filter((e) => !set.has(e.channel))
    )
  }

  const getSubscriptions = (deviceId: string): string[] => {
    const entries = subs.get(deviceId) || []
    return [...new Set(entries.map((e) => e.channel))]
  }

  const getSubscribers = (channel: string, scope?: Record<string, string>): string[] => {
    const result: string[] = []
    for (const [deviceId, entries] of subs) {
      for (const entry of entries) {
        if (entry.channel !== channel) continue
        if (scope) {
          // If filtering by scope, match entries that either have no scope (wildcard) or matching scope
          if (entry.scope) {
            const matches = Object.keys(scope).every((k) => entry.scope![k] === scope[k])
            if (!matches) continue
          }
          // entry.scope is undefined = wildcard, always matches
        }
        result.push(deviceId)
        break
      }
    }
    return result
  }

  const removeDevice = (deviceId: string): string[] => {
    const entries = subs.get(deviceId) || []
    const channels = [...new Set(entries.map((e) => e.channel))]
    subs.delete(deviceId)
    return channels
  }

  return { subscribe, unsubscribe, getSubscriptions, getSubscribers, removeDevice }
}
