const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

export function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`

  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `Today at ${time}`
  }

  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${pad2(d.getDate())} at ${time}`
}

export function formatRelativeTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts

  if (diff < 60_000) return 'Just now'

  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(diff / 86_400_000)
  if (days === 1) return 'Yesterday'

  return `${days}d ago`
}
