// Exponential backoff reconnection

export interface ReconnectorOpts {
  initialMs?: number
  maxMs?: number
  jitter?: boolean
}

export interface Reconnector {
  nextDelay(): number
  reset(): void
  attempt: number
}

export function createReconnector(opts: ReconnectorOpts = {}): Reconnector {
  const initialMs = opts.initialMs ?? 1000
  const maxMs = opts.maxMs ?? 30000
  const jitter = opts.jitter !== false

  let attempt = 0

  const nextDelay = (): number => {
    const base = Math.min(initialMs * Math.pow(2, attempt), maxMs)
    attempt++
    if (jitter) {
      return base * (0.5 + Math.random() * 0.5)
    }
    return base
  }

  const reset = (): void => {
    attempt = 0
  }

  return {
    nextDelay,
    reset,
    get attempt() {
      return attempt
    }
  }
}
