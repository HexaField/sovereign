// PresenceTracker — server-side record of which thread each device currently
// has focused. Used to decide whether an agent-turn completion should fire a
// push notification (suppressed when ANY device on this Sovereign instance
// already has the thread visible).
//
// In-memory only. A device's focus state is meaningless across a daemon
// restart (the WS connection is gone, the client will re-declare focus on
// reconnect), so persistence would be pure overhead.

export interface PresenceTracker {
  setFocus(deviceId: string, threadId: string): void
  blur(deviceId: string): void
  clearDevice(deviceId: string): void
  /** All thread IDs that have at least one device focused on them. */
  focusedThreads(): Set<string>
  /** Device IDs currently focused on `threadId`. */
  devicesFocusedOn(threadId: string): string[]
  /** True iff any device has `threadId` focused. */
  isThreadFocused(threadId: string): boolean
  /** Diagnostic snapshot. */
  snapshot(): Record<string, string>
}

export function createPresenceTracker(): PresenceTracker {
  const deviceFocus = new Map<string, string>()

  const setFocus = (deviceId: string, threadId: string): void => {
    if (!deviceId || !threadId) return
    deviceFocus.set(deviceId, threadId)
  }

  const blur = (deviceId: string): void => {
    if (!deviceId) return
    deviceFocus.delete(deviceId)
  }

  const clearDevice = (deviceId: string): void => {
    if (!deviceId) return
    deviceFocus.delete(deviceId)
  }

  const focusedThreads = (): Set<string> => new Set(deviceFocus.values())

  const devicesFocusedOn = (threadId: string): string[] => {
    const result: string[] = []
    for (const [dev, tid] of deviceFocus) {
      if (tid === threadId) result.push(dev)
    }
    return result
  }

  const isThreadFocused = (threadId: string): boolean => {
    for (const tid of deviceFocus.values()) {
      if (tid === threadId) return true
    }
    return false
  }

  const snapshot = (): Record<string, string> => Object.fromEntries(deviceFocus)

  return { setFocus, blur, clearDevice, focusedThreads, devicesFocusedOn, isThreadFocused, snapshot }
}
