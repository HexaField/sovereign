// Agent Backend — OpenClaw Gateway Implementation

import type { AgentBackend, AgentBackendEvents, BackendConnectionStatus, ParsedTurn, WorkItem } from '@sovereign/core'
import type { OpenClawConfig, DeviceIdentity, InternalState } from './types.js'
import { stripThinkingBlocks } from './thinking.js'
import { parseTurns } from './parse-turns.js'
import { getSessionFilePath, readRecentMessages } from './session-reader.js'
import WebSocket from 'ws'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { generateKeyPairSync, sign, createPrivateKey, createHash } from 'node:crypto'

const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30000
const REQUEST_TIMEOUT = 30000

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
  return sig.toString('base64url')
}

function deriveDeviceId(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')
}

function publicKeyBase64Url(publicKeyHex: string): string {
  return Buffer.from(publicKeyHex, 'hex').toString('base64url')
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

export function createOpenClawBackend(config: OpenClawConfig): AgentBackend & {
  getDeviceInfo(): {
    deviceId: string
    publicKey: string
    connectionStatus: string
    gatewayUrl: string
    reconnectAttempt: number
  }
  listGatewaySessions(): Promise<
    Array<{
      key: string
      label?: string
      kind?: string
      lastActivity?: number
      agentStatus?: string
    }>
  >
} {
  const emitter = createEventEmitter()

  const state: InternalState = {
    connectionStatus: 'disconnected',
    agentStatus: 'idle',
    reconnectAttempt: 0,
    activeSessionKey: null,
    ws: null,
    reconnectTimer: null,
    retryTimer: null,
    destroyed: false
  }

  let currentConfig = { ...config }

  // Pending RPC requests awaiting response
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let msgId = 0

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

  function setStatus(status: BackendConnectionStatus, reason?: string, errorType?: string) {
    state.connectionStatus = status
    emitter.emit('backend.status', { status, reason, errorType })
  }

  /** Send a JSON-RPC style request to the gateway and return a promise for the response. */
  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'))
      }
      const id = 'r' + String(++msgId)
      pending.set(id, { resolve, reject })
      state.ws.send(JSON.stringify({ type: 'req', id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`Request ${method} timed out`))
        }
      }, REQUEST_TIMEOUT)
    })
  }

  function handleMessage(raw: string) {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    // Handle RPC responses — match to pending requests
    if (msg.type === 'res') {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        if (msg.ok === false || msg.error) {
          p.reject(new Error(msg.error?.message ?? msg.error ?? 'request failed'))
        } else {
          p.resolve(msg.payload ?? msg.result ?? null)
        }
      }
      return
    }

    // Handle events from the gateway
    if (msg.type === 'event') {
      handleEvent(msg.event, msg.payload)
      return
    }
  }

  function handleEvent(event: string, payload: any) {
    if (!payload) return

    const sessionKey = payload.sessionKey as string | undefined

    if (!sessionKey) return // No session key — can't route, drop event

    switch (event) {
      case 'chat': {
        handleChatEvent(sessionKey, payload)
        break
      }
      case 'agent': {
        handleAgentEvent(sessionKey, payload)
        break
      }
      case 'health': {
        // Health check event — no action needed
        break
      }
    }
  }

  // Track accumulated streaming text per session to compute true deltas
  const lastStreamLengths = new Map<string, number>()

  function handleChatEvent(sessionKey: string, ev: any) {
    if (ev.state === 'delta') {
      // Gateway delta contains full accumulated text — compute the true delta
      const text = extractText(ev.message)
      const cleaned = text
        ? stripThinkingBlocks(text)
            .replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '')
            .trim()
        : ''
      const lastLen = lastStreamLengths.get(sessionKey) ?? 0
      if (cleaned && cleaned.length > lastLen) {
        const delta = cleaned.substring(lastLen)
        lastStreamLengths.set(sessionKey, cleaned.length)
        emitter.emit('chat.stream', { sessionKey, text: delta })
      }
    } else if (ev.state === 'final') {
      lastStreamLengths.delete(sessionKey)
      // Completed turn
      const text = extractText(ev.message)
      const cleaned = text ? stripThinkingBlocks(text) : ''
      if (cleaned) {
        const turn: ParsedTurn = {
          role: 'assistant',
          content: cleaned,
          timestamp: Date.now(),
          workItems: [],
          thinkingBlocks: []
        }
        emitter.emit('chat.turn', { sessionKey, turn })
      }
      emitter.emit('chat.status', { sessionKey, status: 'idle' })
    }
  }

  function handleAgentEvent(sessionKey: string, ev: any) {
    const data = ev.data ?? {}
    const stream = ev.stream as string | undefined
    const phase = data.phase as string | undefined

    switch (stream) {
      case 'lifecycle': {
        if (phase === 'start') {
          state.agentStatus = 'working'
          emitter.emit('chat.status', { sessionKey, status: 'working' })
        } else if (phase === 'end' || phase === 'error') {
          if (phase === 'error') {
            const reason = data.error || data.reason || data.stopReason || ''
            emitter.emit('chat.error', { sessionKey, error: reason || 'Agent error', retryAfterMs: data.retryAfterMs })
          }
          state.agentStatus = 'idle'
          emitter.emit('chat.status', { sessionKey, status: 'idle' })
        }
        break
      }
      case 'tool': {
        const work: WorkItem = {
          type: phase === 'result' ? 'tool_result' : 'tool_call',
          name: data.name,
          input: data.input,
          output: data.output,
          toolCallId: data.toolCallId,
          timestamp: data.timestamp ?? Date.now()
        }
        emitter.emit('chat.work', { sessionKey, work })
        break
      }
      case 'thinking': {
        const work: WorkItem = {
          type: 'thinking',
          output: data.text ?? data.content ?? data.delta ?? '',
          timestamp: data.timestamp ?? Date.now()
        }
        emitter.emit('chat.work', { sessionKey, work })
        break
      }
      case 'compaction': {
        emitter.emit('chat.compacting', { sessionKey, active: phase === 'start' })
        break
      }
      case 'assistant': {
        // Assistant stream — indicates agent is producing text, status can be cleared
        break
      }
    }
  }

  /** Extract text content from a gateway ChatMessage (ContentBlock[] or string). */
  function extractText(message: unknown): string | null {
    if (!message) return null
    if (typeof message === 'string') return message
    if (Array.isArray(message)) {
      return message
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text ?? '')
        .join('')
    }
    if (typeof message === 'object' && 'content' in (message as any)) {
      return extractText((message as any).content)
    }
    return null
  }

  function connectWs(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (state.destroyed) return reject(new Error('Backend destroyed'))

      setStatus('connecting')

      try {
        const ws = new WebSocket(currentConfig.gatewayUrl, {
          headers: { origin: 'http://localhost:5801' }
        })
        state.ws = ws

        let settled = false
        let connectNonce = ''

        ws.on('open', () => {
          state.reconnectAttempt = 0
        })

        ws.on('message', async (data: any) => {
          const raw = data.toString()
          let msg: any
          try {
            msg = JSON.parse(raw)
          } catch {
            return
          }

          // Handle connect.challenge event — sign and send connect request
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce
            if (nonce) connectNonce = nonce

            try {
              const id = getIdentity()
              const deviceId = deriveDeviceId(id.publicKey)
              const pubKeyB64 = publicKeyBase64Url(id.publicKey)
              const storedToken = getDeviceToken(deviceId) || currentConfig.gatewayToken || ''
              const signedAt = Date.now()
              const payload = [
                'v2',
                deviceId,
                'openclaw-control-ui',
                'webchat',
                'operator',
                'operator.read,operator.write,operator.admin',
                String(signedAt),
                storedToken,
                connectNonce
              ].join('|')
              const signature = signPayload(id, payload)

              const reqId = 'c' + Date.now()
              // Register this as a pending request so the normal res handler picks it up
              pending.set(reqId, {
                resolve: (result) => {
                  if (settled) return
                  settled = true

                  const auth = (result as any)?.auth
                  if (auth?.deviceToken) {
                    saveDeviceToken(deviceId, auth.deviceToken)
                  }

                  setStatus('connected')
                  resolve()
                },
                reject: (err) => {
                  if (settled) return
                  settled = true
                  const isPairing = err.message?.includes('pairing')
                  setStatus('error', err.message, isPairing ? 'auth_rejected' : 'server_down')
                  reject(err)
                }
              })

              ws.send(
                JSON.stringify({
                  type: 'req',
                  id: reqId,
                  method: 'connect',
                  params: {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: {
                      id: 'openclaw-control-ui',
                      version: '2.0',
                      platform: process.platform,
                      mode: 'webchat'
                    },
                    role: 'operator',
                    scopes: ['operator.read', 'operator.write', 'operator.admin'],
                    device: {
                      id: deviceId,
                      publicKey: pubKeyB64,
                      signature,
                      signedAt,
                      nonce: connectNonce
                    },
                    auth: { token: storedToken },
                    userAgent: `Sovereign/0.1.0 (Node ${process.version})`,
                    caps: []
                  }
                })
              )
            } catch (err) {
              if (!settled) {
                settled = true
                reject(err as Error)
              }
            }
            return
          }

          // All other messages go through unified handler (res + event)
          handleMessage(raw)

          // Check if connect settled via the res handler
          // (The pending map resolve/reject for the connect reqId handles this)
        })

        ws.on('close', () => {
          if (state.destroyed) return
          // Reject all pending requests
          pending.forEach((p) => p.reject(new Error('Connection closed')))
          pending.clear()
          if (!settled) {
            settled = true
            setStatus('disconnected', 'Connection closed before handshake', 'server_down')
            reject(new Error('Connection closed before handshake'))
          } else {
            setStatus('disconnected', 'Connection lost')
          }
          scheduleReconnect()
        })

        ws.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            const errorType = err.message?.includes('certificate') ? 'cert_error' : 'server_down'
            setStatus('disconnected', err.message, errorType)
            reject(err)
          }
        })
      } catch (err) {
        setStatus('disconnected')
        reject(err as Error)
      }
    })
  }

  // Device token persistence
  function getDeviceTokenPath(): string {
    return join(currentConfig.dataDir ?? '.data', 'agent-backend', 'device-token.json')
  }

  function saveDeviceToken(deviceId: string, token: string): void {
    try {
      const dir = dirname(getDeviceTokenPath())
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(getDeviceTokenPath(), JSON.stringify({ deviceId, token }))
    } catch {
      /* best effort */
    }
  }

  function getDeviceToken(deviceId: string): string | null {
    try {
      const data = JSON.parse(readFileSync(getDeviceTokenPath(), 'utf-8'))
      if (data.deviceId === deviceId) return data.token
    } catch {
      /* not found */
    }
    return null
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
      } catch (err) {
        emitter.emit('backend.status', {
          status: 'disconnected',
          reason: `Reconnect attempt ${state.reconnectAttempt} failed: ${(err as Error).message}`,
          errorType: 'reconnect_failed'
        })
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
    // Reject all pending requests
    pending.forEach((p) => p.reject(new Error('Backend disconnected')))
    pending.clear()
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

  const backend = {
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
      const params: Record<string, unknown> = {
        sessionKey,
        message: text,
        deliver: false,
        idempotencyKey: 'r' + Date.now()
      }
      if (attachments?.length) {
        params.attachments = attachments.map((b) => b.toString('base64'))
      }
      await request('chat.send', params)
    },

    async abort(sessionKey: string) {
      await request('chat.abort', { sessionKey }).catch(() => {})
    },

    async switchSession(sessionKey: string) {
      state.activeSessionKey = sessionKey
      await request('session.switch', { sessionKey }).catch(() => {})
    },

    async createSession(label?: string): Promise<string> {
      const result = (await request('session.create', { label })) as { sessionKey?: string }
      if (!result?.sessionKey) throw new Error('No sessionKey in response')
      return result.sessionKey
    },

    async getHistory(sessionKey: string): Promise<{ turns: ParsedTurn[]; hasMore: boolean }> {
      // Fast path: read session JSONL file directly (sub-millisecond)
      const filePath = getSessionFilePath(sessionKey)
      if (filePath) {
        try {
          const t0 = Date.now()
          const { messages, hasMore } = readRecentMessages(filePath, 500)
          if (messages.length > 0) {
            const turns = parseTurns(messages)
            const elapsed = Date.now() - t0
            if (elapsed > 50) console.log(`[session-reader] ${sessionKey}: ${elapsed}ms, ${messages.length} raw → ${turns.length} turns`)
            return { turns, hasMore }
          }
        } catch {
          /* fall through to RPC */
        }
      }

      // Fallback: gateway RPC (slow, 200-600ms)
      const result = (await request('chat.history', { sessionKey, limit: 200 })) as {
        messages?: any[]
      }
      const raw = result?.messages ?? []
      return { turns: parseTurns(raw), hasMore: false }
    },

    async getFullHistory(sessionKey: string): Promise<ParsedTurn[]> {
      // Read ALL messages from file (no limit)
      const filePath = getSessionFilePath(sessionKey)
      if (filePath) {
        try {
          const { messages } = readRecentMessages(filePath, 100000)
          if (messages.length > 0) {
            return parseTurns(messages)
          }
        } catch {
          /* fall through to RPC */
        }
      }
      const result = (await request('chat.history', { sessionKey, limit: 10000 })) as {
        messages?: any[]
      }
      return parseTurns(result?.messages ?? [])
    },

    on: emitter.on,
    off: emitter.off,

    getDeviceInfo() {
      const id = getIdentity()
      const deviceId = deriveDeviceId(id.publicKey)
      return {
        deviceId,
        publicKey: id.publicKey,
        connectionStatus: state.connectionStatus,
        gatewayUrl: config.gatewayUrl,
        reconnectAttempt: state.reconnectAttempt
      }
    },

    async listGatewaySessions(): Promise<
      Array<{
        key: string
        label?: string
        kind?: string
        lastActivity?: number
        agentStatus?: string
      }>
    > {
      try {
        const result = (await request('sessions.list', { limit: 200 })) as {
          sessions?: any[]
        }
        return (result?.sessions ?? []).map((s: any) => ({
          key: s.key ?? s.sessionKey ?? '',
          label: s.label,
          kind: s.kind,
          lastActivity: s.lastActivity ?? s.updatedAt,
          agentStatus: s.agentStatus ?? s.status
        }))
      } catch (err: any) {
        console.error('[gateway] sessions.list failed:', err.message)
        return []
      }
    }
  }

  return backend
}
