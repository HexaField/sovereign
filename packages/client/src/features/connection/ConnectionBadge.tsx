import { connectionStatus } from './store.js'

export function ConnectionBadge() {
  const color = () => {
    const s = connectionStatus()
    if (s === 'connected') return 'var(--c-accent)'
    if (s === 'connecting' || s === 'authenticating') return 'var(--c-amber)'
    return 'var(--c-danger)'
  }

  return <div class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color() }} />
}
