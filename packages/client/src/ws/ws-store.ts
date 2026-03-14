// Reactive WebSocket store

import type { WsMessage } from '@sovereign/core'
import { createReconnector } from './reconnect.js'

export interface WsStore {
  connected: () => boolean
  subscribe(channels: string[], scope?: Record<string, string>): void
  unsubscribe(channels: string[]): void
  on<T extends WsMessage>(type: string, handler: (msg: T) => void): () => void
  send(msg: WsMessage): void
  close(): void
}

export interface WsStoreOptions {
  url: string
  WebSocket?: new (url: string) => WebSocketLike
}

interface WebSocketLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

const WS_OPEN = 1

export function createWsStore(options: WsStoreOptions): WsStore {
  const { url } = options
  const WsCtor = options.WebSocket as (new (url: string) => WebSocketLike) | undefined

  let ws: WebSocketLike | null = null
  let isConnected = false
  const handlers = new Map<string, Set<(msg: WsMessage) => void>>()
  const activeSubscriptions: Array<{ channels: string[]; scope?: Record<string, string> }> = []
  const queue: WsMessage[] = []
  const reconnector = createReconnector()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const connected = (): boolean => isConnected

  const sendRaw = (msg: WsMessage): void => {
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      queue.push(msg)
    }
  }

  const resubscribe = (): void => {
    for (const sub of activeSubscriptions) {
      sendRaw({ type: 'subscribe', channels: sub.channels, scope: sub.scope } as unknown as WsMessage)
    }
  }

  const flushQueue = (): void => {
    while (queue.length > 0) {
      const msg = queue.shift()!
      sendRaw(msg)
    }
  }

  const connect = (): void => {
    if (closed) return
    if (!WsCtor) return
    ws = new WsCtor(url)

    ws.onopen = () => {
      isConnected = true
      reconnector.reset()
      resubscribe()
      flushQueue()
    }

    ws.onclose = () => {
      isConnected = false
      ws = null
      if (!closed) {
        scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose will fire after onerror
    }

    ws.onmessage = (ev: { data: string }) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage
        const set = handlers.get(msg.type)
        if (set) {
          for (const h of set) h(msg)
        }
      } catch {
        // ignore parse errors on client
      }
    }
  }

  const scheduleReconnect = (): void => {
    if (closed) return
    const delay = reconnector.nextDelay()
    reconnectTimer = setTimeout(() => {
      connect()
    }, delay)
  }

  const subscribe = (channels: string[], scope?: Record<string, string>): void => {
    activeSubscriptions.push({ channels, scope })
    sendRaw({ type: 'subscribe', channels, scope } as unknown as WsMessage)
  }

  const unsubscribe = (channels: string[]): void => {
    const set = new Set(channels)
    for (let i = activeSubscriptions.length - 1; i >= 0; i--) {
      activeSubscriptions[i].channels = activeSubscriptions[i].channels.filter((c) => !set.has(c))
      if (activeSubscriptions[i].channels.length === 0) activeSubscriptions.splice(i, 1)
    }
    sendRaw({ type: 'unsubscribe', channels } as unknown as WsMessage)
  }

  const on = <T extends WsMessage>(type: string, handler: (msg: T) => void): (() => void) => {
    if (!handlers.has(type)) handlers.set(type, new Set())
    const h = handler as (msg: WsMessage) => void
    handlers.get(type)!.add(h)
    return () => {
      handlers.get(type)?.delete(h)
    }
  }

  const send = (msg: WsMessage): void => {
    sendRaw(msg)
  }

  const close = (): void => {
    closed = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
  }

  // Auto-connect
  connect()

  return { connected, subscribe, unsubscribe, on, send, close }
}
