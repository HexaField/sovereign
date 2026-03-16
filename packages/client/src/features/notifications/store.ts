import { createSignal } from 'solid-js'

export const [unreadNotificationCount, setUnreadNotificationCount] = createSignal(0)

let pollInterval: ReturnType<typeof setInterval> | null = null

export function startNotificationPolling(): void {
  if (pollInterval) return

  const fetchCount = async () => {
    try {
      const res = await fetch('/api/notifications/unread-count')
      if (res.ok) {
        const data = await res.json()
        setUnreadNotificationCount(typeof data.count === 'number' ? data.count : 0)
      }
    } catch {
      // ignore
    }
  }

  fetchCount()
  pollInterval = setInterval(fetchCount, 15_000)
}

export function stopNotificationPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}
