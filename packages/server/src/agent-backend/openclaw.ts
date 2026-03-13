// Agent Backend — OpenClaw Gateway Implementation

import type { AgentBackend, AgentBackendEvents, BackendConnectionStatus, ParsedTurn, WorkItem } from '@template/core'
import type { OpenClawConfig, DeviceIdentity, InternalState } from './types.js'
import { stripThinkingBlocks } from './thinking.js'
import WebSocket from 'ws'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { generateKeyPairSync, sign, createPrivateKey } from 'node:crypto'

const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30000
const HISTORY_RELOAD_DEBOUNCE = 300

function createEventEmitter() {
  const listeners = new Map<string, Set<(data: any) => void>>()

  return {
    on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    },
    off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void) {
      listeners.get(event)?.delete(handler)
    },
    emit<K extends keyof AgentBackendEvents>(event: K, data: AgentBackendEvents[K]) {
      listeners.get(event)?.forEach((fn) => fn(data))
    }
  }
}

function loadOrCreateIdentity(keyPath: string): DeviceIdentity {
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, 'utf-8'))
    return raw as DeviceIdentity
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' })
  // Ed25519 public key raw bytes are last 32 bytes of SPKI DER
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const identity: DeviceIdentity = {
    publicKey: pubRaw.toString('hex'),
    privateKeyDer: privDer.toString('base64')
  }
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, JSON.stringify(identity, null, 2))
  return identity
}

function signPayload(identity: DeviceIdentity, payload: string): string {
  const privKey = createPrivateKey({
    key: Buffer.from(identity.privateKeyDer, 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  const sig = sign(null, Buffer.from(payload), privKey)
  return sig.toString('hex')
}

function calcReconnectDelay(attempt: number, config: OpenClawConfig): number {
  const initial = config.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY
  const max = config.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY
  const jitter = config.reconnect?.jitter !== false
  let delay = Math.min(initial * Math.pow(2, attempt), max)
  if (jitter) {
    delay = delay * (1 + Math.random() * 0.1)
  }
  return delay
}

export function createOpenClawBackend(config: OpenClawConfig): AgentBackend {
  const emitter = createEventEmitter()

  const state: InternalState = {
    connectionStatus: 'disconnected',
    agentStatus: 'idle',
    reconnectAttempt: 0,
    activeSessionKey: null,
    ws: null,
    reconnectTimer: null,
    historyReloadTimer: null,
    retryTimer: null,
    destroyed: false
  }

  let currentConfig = { ...config }

  function getKeyPath(): string {
    if (currentConfig.deviceKeyPath) return currentConfig.deviceKeyPath
    const dataDir = currentConfig.dataDir ?? '.'
    return join(dataDir, 'agent-backend', 'device-identity.json')
  }

  let identity: DeviceIdentity | null = null

  function getIdentity(): DeviceIdentity {
    if (!identity) {
      identity = loadOrCreateIdentity(getKeyPath())
    }
    return identity
  }

  function setStatus(status: BackendConnectionStatus) {
    state.connectionStatus = status
    emitter.emit('backend.status', { status })
  }

  function handleMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    const sessionKey = msg.sessionKey ?? state.activeSessionKey ?? 'main'

    switch (msg.type) {
      case 'stream':
      case 'chat.stream': {
        const text = stripThinkingBlocks(msg.text ?? msg.data ?? '')
        if (text) {
          emitter.emit('chat.stream', { sessionKey, text })
        }
        break
      }
      case 'turn':
      case 'chat.turn': {
        const turn: ParsedTurn = {
          role: msg.turn?.role ?? msg.role ?? 'assistant',
          content: stripThinkingBlocks(msg.turn?.content ?? msg.content ?? ''),
          timestamp: msg.turn?.timestamp ?? msg.timestamp ?? Date.now(),
          workItems: msg.turn?.workItems ?? msg.workItems ?? [],
          thinkingBlocks: msg.turn?.thinkingBlocks ?? msg.thinkingBlocks ?? []
        }
        emitter.emit('chat.turn', { sessionKey, turn })
        break
      }
      case 'status':
      case 'chat.status': {
        const agentStatus = msg.status ?? msg.agentStatus
        if (agentStatus) {
          const prevStatus = state.agentStatus
          state.agentStatus = agentStatus
          emitter.emit('chat.status', { sessionKey, status: agentStatus })
          if (prevStatus === 'working' && agentStatus === 'idle') {
            scheduleHistoryReload(sessionKey)
          }
        }
        break
      }
      case 'work':
      case 'chat.work': {
        const work: WorkItem = msg.work ?? {
          type: msg.workType ?? 'tool_call',
          name: msg.name,
          input: msg.input,
          output: msg.output,
          toolCallId: msg.toolCallId,
          timestamp: msg.timestamp ?? Date.now()
        }
        emitter.emit('chat.work', { sessionKey, work })
        break
      }
      case 'thinking':
      case 'chat.thinking': {
        const work: WorkItem = {
          type: 'thinking',
          output: msg.text ?? msg.content ?? '',
          timestamp: msg.timestamp ?? Date.now()
        }
        emitter.emit('chat.work', { sessionKey, work })
        break
      }
      case 'compacting':
      case 'chat.compacting': {
        emitter.emit('chat.compacting', { sessionKey, active: msg.active ?? true })
        break
      }
      case 'error':
      case 'chat.error': {
        const retryAfterMs = msg.retryAfterMs ?? msg.retryAfter
        emitter.emit('chat.error', { sessionKey, error: msg.error ?? msg.message ?? 'Unknown error', retryAfterMs })
        if (retryAfterMs) {
          state.retryTimer = setTimeout(() => {
            state.retryTimer = null
            if (state.ws?.readyState === WebSocket.OPEN) {
              state.ws.send(JSON.stringify({ type: 'retry' }))
            }
          }, retryAfterMs)
        }
        break
      }
      case 'session.info': {
        emitter.emit('session.info', {
          sessionKey: msg.sessionKey ?? sessionKey,
          label: msg.label,
          history: msg.history ?? []
        })
        break
      }
      case 'pairing.required': {
        setStatus('error')
        break
      }
    }
  }

  function scheduleHistoryReload(sessionKey: string) {
    if (state.historyReloadTimer) {
      clearTimeout(state.historyReloadTimer)
    }
    state.historyReloadTimer = setTimeout(() => {
      state.historyReloadTimer = null
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'history', sessionKey }))
      }
    }, HISTORY_RELOAD_DEBOUNCE)
  }

  function connectWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (state.destroyed) return reject(new Error('Backend destroyed'))

      setStatus('connecting')

      try {
        const id = getIdentity()
        const timestamp = Date.now().toString()
        const signature = signPayload(id, timestamp)

        const wsUrl =
          currentConfig.gatewayUrl +
          (currentConfig.gatewayUrl.includes('?') ? '&' : '?') +
          `publicKey=${id.publicKey}&timestamp=${encodeURIComponent(timestamp)}&signature=${signature}`

        const ws = new WebSocket(wsUrl)
        state.ws = ws

        let settled = false

        ws.on('open', () => {
          if (settled) return
          settled = true
          state.reconnectAttempt = 0
          setStatus('connected')
          resolve()
        })

        ws.on('message', (data: any) => {
          handleMessage(data.toString())
        })

        ws.on('close', () => {
          if (state.destroyed) return
          if (!settled) {
            settled = true
            setStatus('disconnected')
            reject(new Error('Connection closed before open'))
          } else {
            setStatus('disconnected')
          }
          scheduleReconnect()
        })

        ws.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            setStatus('disconnected')
            reject(err)
          }
        })
      } catch (err) {
        setStatus('disconnected')
        reject(err as Error)
      }
    })
  }

  function scheduleReconnect() {
    if (state.destroyed || state.reconnectTimer) return
    const delay = calcReconnectDelay(state.reconnectAttempt, currentConfig)
    state.reconnectAttempt++
    state.reconnectTimer = setTimeout(async () => {
      state.reconnectTimer = null
      if (state.destroyed) return
      try {
        await connectWs()
      } catch {
        // connectWs failure will trigger close -> scheduleReconnect again
      }
    }, delay)
  }

  function cleanup() {
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    if (state.historyReloadTimer) {
      clearTimeout(state.historyReloadTimer)
      state.historyReloadTimer = null
    }
    if (state.ws) {
      state.ws.removeAllListeners()
      if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
        state.ws.close()
      }
      state.ws = null
    }
  }

  // Hot-reload support
  if (config.onConfigChange) {
    config.onConfigChange((newConfig) => {
      const urlChanged = newConfig.gatewayUrl && newConfig.gatewayUrl !== currentConfig.gatewayUrl
      Object.assign(currentConfig, newConfig)
      if (urlChanged) {
        cleanup()
        state.destroyed = false
        connectWs().catch(() => {})
      }
    })
  }

  const backend: AgentBackend = {
    async connect() {
      state.destroyed = false
      await connectWs()
    },

    async disconnect() {
      state.destroyed = true
      cleanup()
      setStatus('disconnected')
    },

    status(): BackendConnectionStatus {
      return state.connectionStatus
    },

    async sendMessage(sessionKey: string, text: string, attachments?: Buffer[]) {
      if (state.ws?.readyState !== WebSocket.OPEN) {
        throw new Error('Not connected')
      }
      const msg: any = { type: 'chat.send', sessionKey, text }
      if (attachments?.length) {
        msg.attachments = attachments.map((b) => b.toString('base64'))
      }
      state.ws.send(JSON.stringify(msg))
    },

    async abort(sessionKey: string) {
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'chat.abort', sessionKey }))
      }
    },

    async switchSession(sessionKey: string) {
      state.activeSessionKey = sessionKey
      if (state.ws?.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'session.switch', sessionKey }))
      }
    },

    async createSession(label?: string): Promise<string> {
      return new Promise((resolve, reject) => {
        if (state.ws?.readyState !== WebSocket.OPEN) {
          return reject(new Error('Not connected'))
        }
        const requestId = Math.random().toString(36).slice(2)
        const handler = (data: any) => {
          try {
            const msg = JSON.parse(data.toString())
            if (msg.type === 'session.created' && msg.requestId === requestId) {
              state.ws?.off('message', handler)
              resolve(msg.sessionKey)
            }
          } catch {
            /* ignore parse errors */
          }
        }
        state.ws.on('message', handler)
        state.ws.send(JSON.stringify({ type: 'session.create', label, requestId }))
        setTimeout(() => {
          state.ws?.off('message', handler)
          reject(new Error('Session creation timeout'))
        }, 10000)
      })
    },

    async getHistory(sessionKey: string): Promise<ParsedTurn[]> {
      return new Promise((resolve, reject) => {
        if (state.ws?.readyState !== WebSocket.OPEN) {
          return reject(new Error('Not connected'))
        }
        const requestId = Math.random().toString(36).slice(2)
        const handler = (data: any) => {
          try {
            const msg = JSON.parse(data.toString())
            if (msg.type === 'session.info' && (msg.requestId === requestId || msg.sessionKey === sessionKey)) {
              state.ws?.off('message', handler)
              resolve(msg.history ?? [])
            }
          } catch {
            /* ignore parse errors */
          }
        }
        state.ws.on('message', handler)
        state.ws.send(JSON.stringify({ type: 'history', sessionKey, requestId }))
        setTimeout(() => {
          state.ws?.off('message', handler)
          reject(new Error('History fetch timeout'))
        }, 10000)
      })
    },

    on: emitter.on,
    off: emitter.off
  }

  return backend
}
