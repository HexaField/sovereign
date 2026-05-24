// Agent Backend — OpenClaw Gateway Implementation

import type {
  AgentBackend,
  AgentBackendKind,
  BackendCapabilities,
  BackendConnectionStatus,
  ContextBudget,
  DeviceInfo,
  ParsedTurn,
  SessionKind,
  SessionMeta,
  SessionSummary,
  SpawnSubagentOptions,
  SubagentSummary,
  WorkItem
} from '@sovereign/core'
import type { OpenClawConfig, DeviceIdentity, InternalState } from './types.js'
import { stripThinkingBlocks } from '../shared/thinking.js'
import { createBackendEmitter } from '../shared/event-emitter.js'
import { parseTurns } from './parse-turns.js'
import {
  defaultOpenClawPaths,
  type OpenClawPaths,
  getSessionFilePath as openClawGetSessionFile,
  getAllSessionFiles as openClawGetAllSessionFiles,
  readRecentMessages as openClawReadRecent,
  readAllMessages as openClawReadAll
} from './session-reader.js'
import { restartOpenClawGateway } from './restart-service.js'
import { createOpenClawCronBridge, type OpenClawCronBridge } from './cron-bridge.js'
import WebSocket from 'ws'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { generateKeyPairSync, sign, createPrivateKey, createHash } from 'node:crypto'

const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30000
const REQUEST_TIMEOUT = 30000

const KIND: AgentBackendKind = 'openclaw'

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

function classifySessionKey(key: string): SessionKind {
  if (key === 'agent:main:main' || key.endsWith(':main')) return 'main'
  if (key.includes(':thread:')) return 'thread'
  if (key.includes(':cron:')) return 'cron'
  if (key.includes(':subagent:')) return 'subagent'
  if (key.includes(':event-agent:')) return 'event-agent'
  return 'unknown'
}

export interface OpenClawBackend extends AgentBackend {
  /** OpenClaw-only: gateway sessions list (used internally and by chat SSE for status fallback). */
  listGatewaySessions(): Promise<
    Array<{ key: string; label?: string; kind?: string; lastActivity?: number; agentStatus?: string }>
  >
  /** Bridge that wraps gateway cron RPC for use by Sovereign's CronService. */
  cronBridge: OpenClawCronBridge
  /** OpenClaw filesystem path resolver — exposed so the OpenClaw-aware routes can use it. */
  paths: OpenClawPaths
}

export function createOpenClawBackend(config: OpenClawConfig): OpenClawBackend {
  const emitter = createBackendEmitter(KIND)

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
  const paths: OpenClawPaths = {
    ...defaultOpenClawPaths(),
    ...(currentConfig.sessionsJsonPath
      ? { sessionsJsonPath: currentConfig.sessionsJsonPath, sessionsDir: dirname(currentConfig.sessionsJsonPath) }
      : {}),
    ...(currentConfig.sessionsDir ? { sessionsDir: currentConfig.sessionsDir } : {}),
    ...(currentConfig.openClawConfigPath ? { openClawConfigPath: currentConfig.openClawConfigPath } : {})
  }

  type ReadinessGate = {
    ready: boolean
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
  }

  function createReadinessGate(): ReadinessGate {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    promise.catch(() => {})
    return { ready: false, promise, resolve, reject }
  }

  let handshakeReady = createReadinessGate()

  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  const historyCache = new Map<string, { turns: ParsedTurn[]; hasMore: boolean; mtime: number; size: number }>()
  const HISTORY_CACHE_MAX = 50
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

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== 'connect' && !handshakeReady.ready) {
      await handshakeReady.promise
    }

    return await new Promise((resolve, reject) => {
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

    if (msg.type === 'event') {
      handleEvent(msg.event, msg.payload)
      return
    }
  }

  function handleEvent(event: string, payload: any) {
    if (!payload) return
    const sessionKey = payload.sessionKey as string | undefined
    if (!sessionKey) return

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
        break
      }
    }
  }

  const lastStreamLengths = new Map<string, number>()
  const seenToolCallIds = new Map<string, Set<string>>()
  const seenToolResultIds = new Map<string, Set<string>>()

  function extractToolCalls(message: unknown): Array<{ id: string; name: string; input: any }> {
    if (!Array.isArray(message)) {
      if (message && typeof message === 'object' && 'content' in (message as any)) {
        return extractToolCalls((message as any).content)
      }
      return []
    }
    return message
      .filter((b: any) => b.type === 'tool_use' || b.type === 'tool_call' || b.type === 'toolCall')
      .map((b: any) => ({ id: b.id || b.toolCallId || '', name: b.name || '', input: b.input ?? b.arguments ?? {} }))
  }

  function extractToolResults(message: unknown): Array<{ toolCallId: string; name?: string; content: any }> {
    if (!Array.isArray(message)) {
      if (message && typeof message === 'object' && 'content' in (message as any)) {
        return extractToolResults((message as any).content)
      }
      if (message && typeof message === 'object') {
        const msg = message as any
        if (msg.role === 'toolResult') {
          return [{ toolCallId: msg.toolCallId || '', name: msg.name, content: msg.content ?? msg.output ?? '' }]
        }
      }
      return []
    }
    return message
      .filter((b: any) => b.type === 'tool_result' || b.type === 'toolResult')
      .map((b: any) => ({
        toolCallId: b.tool_use_id || b.toolCallId || '',
        name: b.name,
        content: b.content ?? b.output ?? ''
      }))
  }

  function extractThinkingBlocks(message: unknown): string[] {
    if (!Array.isArray(message)) {
      if (message && typeof message === 'object' && 'content' in (message as any)) {
        return extractThinkingBlocks((message as any).content)
      }
      return []
    }
    return message
      .filter((b: any) => b.type === 'thinking')
      .map((b: any) => b.thinking || b.text || b.content || '')
      .filter(Boolean)
  }

  function handleChatEvent(sessionKey: string, ev: any) {
    if (ev.state === 'delta') {
      if (state.agentStatus !== 'working') {
        state.agentStatus = 'working'
        emitter.emit('chat.status', { sessionKey, status: 'working' })
      }
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

      const toolCalls = extractToolCalls(ev.message)
      if (!seenToolCallIds.has(sessionKey)) seenToolCallIds.set(sessionKey, new Set())
      const seen = seenToolCallIds.get(sessionKey)!
      for (const tc of toolCalls) {
        if (tc.id && !seen.has(tc.id)) {
          seen.add(tc.id)
          const accum = thinkingAccum.get(sessionKey)
          if (accum) {
            emitter.emit('chat.work', {
              sessionKey,
              work: { type: 'thinking', output: accum, timestamp: Date.now() } as WorkItem
            })
            thinkingAccum.delete(sessionKey)
          }
          const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
          emitter.emit('chat.work', {
            sessionKey,
            work: {
              type: 'tool_call',
              name: tc.name,
              input: inputStr,
              toolCallId: tc.id,
              timestamp: Date.now()
            } as WorkItem
          })
        }
      }

      const toolResults = extractToolResults(ev.message)
      if (!seenToolResultIds.has(sessionKey)) seenToolResultIds.set(sessionKey, new Set())
      const seenResults = seenToolResultIds.get(sessionKey)!
      for (const tr of toolResults) {
        if (tr.toolCallId && !seenResults.has(tr.toolCallId)) {
          seenResults.add(tr.toolCallId)
          const outputStr = contentToOutputStr(tr.content)
          const matchedCall = toolCalls.find((tc) => tc.id === tr.toolCallId)
          emitter.emit('chat.work', {
            sessionKey,
            work: {
              type: 'tool_result',
              name: matchedCall?.name,
              output: outputStr,
              toolCallId: tr.toolCallId,
              timestamp: Date.now()
            } as WorkItem
          })
        }
      }

      const thinkingBlocks = extractThinkingBlocks(ev.message)
      for (const tb of thinkingBlocks) {
        const prev = thinkingAccum.get(sessionKey) ?? ''
        if (tb.length > prev.length) {
          thinkingAccum.set(sessionKey, tb)
        }
      }
    } else if (ev.state === 'final') {
      lastStreamLengths.delete(sessionKey)
      seenToolCallIds.delete(sessionKey)
      seenToolResultIds.delete(sessionKey)

      const accum = thinkingAccum.get(sessionKey)
      if (accum) {
        emitter.emit('chat.work', {
          sessionKey,
          work: { type: 'thinking', output: accum, timestamp: Date.now() } as WorkItem
        })
        thinkingAccum.delete(sessionKey)
      }

      const filePath = openClawGetSessionFile(paths, sessionKey)
      if (filePath) {
        try {
          const { messages } = openClawReadRecent(filePath, 20)
          if (messages.length > 0) {
            const turns = parseTurns(messages)
            const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
            if (lastAssistant) {
              emitter.emit('chat.turn', { sessionKey, turn: lastAssistant })
              emitter.emit('chat.status', { sessionKey, status: 'idle' })
              return
            }
          }
        } catch {
          /* fall through */
        }
      }

      const text = extractText(ev.message)
      const cleaned = text ? stripThinkingBlocks(text) : ''
      const turn: ParsedTurn = {
        role: 'assistant',
        content: cleaned.replace(/\[\[\s*(?:reply_to_current|reply_to:\s*[^\]]*|audio_as_voice)\s*\]\]/g, '').trim(),
        timestamp: Date.now(),
        workItems: [],
        thinkingBlocks: []
      }
      emitter.emit('chat.turn', { sessionKey, turn })
      emitter.emit('chat.status', { sessionKey, status: 'idle' })
    }
  }

  const thinkingAccum = new Map<string, string>()

  function handleAgentEvent(sessionKey: string, ev: any) {
    const data = ev.data ?? {}
    const stream = ev.stream as string | undefined
    const phase = data.phase as string | undefined
    switch (stream) {
      case 'lifecycle': {
        if (phase === 'start') {
          state.agentStatus = 'working'
          thinkingAccum.delete(sessionKey)
          emitter.emit('chat.status', { sessionKey, status: 'working' })
        } else if (phase === 'end' || phase === 'error') {
          if (phase === 'error') {
            const reason = data.error || data.reason || data.stopReason || ''
            emitter.emit('chat.error', { sessionKey, error: reason || 'Agent error', retryAfterMs: data.retryAfterMs })
          }
          const accum = thinkingAccum.get(sessionKey)
          if (accum) {
            emitter.emit('chat.work', {
              sessionKey,
              work: { type: 'thinking', output: accum, timestamp: Date.now() } as WorkItem
            })
            thinkingAccum.delete(sessionKey)
          }
          state.agentStatus = 'idle'
          emitter.emit('chat.status', { sessionKey, status: 'idle' })
        }
        break
      }
      case 'tool': {
        const accum = thinkingAccum.get(sessionKey)
        if (accum) {
          emitter.emit('chat.work', {
            sessionKey,
            work: { type: 'thinking', output: accum, timestamp: Date.now() } as WorkItem
          })
          thinkingAccum.delete(sessionKey)
        }
        const rawInput = data.input ?? data.arguments ?? data.params
        const rawOutput = data.output ?? data.result ?? data.content
        const work: WorkItem = {
          type: phase === 'result' ? 'tool_result' : 'tool_call',
          name: data.name,
          input: typeof rawInput === 'string' ? rawInput : rawInput ? JSON.stringify(rawInput) : undefined,
          output: typeof rawOutput === 'string' ? rawOutput : rawOutput ? JSON.stringify(rawOutput) : undefined,
          toolCallId: data.toolCallId,
          timestamp: data.timestamp ?? Date.now()
        }
        emitter.emit('chat.work', { sessionKey, work })
        break
      }
      case 'thinking': {
        const fullText = (data.text as string) || (data.content as string) || ''
        const delta = (data.delta as string) || ''

        if (fullText) {
          thinkingAccum.set(sessionKey, fullText)
        } else if (delta) {
          const prev = thinkingAccum.get(sessionKey) ?? ''
          thinkingAccum.set(sessionKey, prev + delta)
        }

        const accumulated = thinkingAccum.get(sessionKey) ?? ''
        if (accumulated) {
          emitter.emit('chat.work', {
            sessionKey,
            work: { type: 'thinking', output: accumulated, timestamp: Date.now() } as WorkItem
          })
        }
        break
      }
      case 'compaction': {
        emitter.emit('chat.compacting', { sessionKey, active: phase === 'start' })
        break
      }
      case 'assistant': {
        if (state.agentStatus !== 'working') {
          state.agentStatus = 'working'
          emitter.emit('chat.status', { sessionKey, status: 'working' })
        }
        break
      }
    }
  }

  function contentToOutputStr(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const b of content as any[]) {
        if (b.type === 'text' && b.text) parts.push(b.text)
        else if (b.type === 'image' && b.data) {
          const mime = b.mimeType || (b.data.startsWith('/9j/') ? 'image/jpeg' : 'image/png')
          parts.push(
            `<img src="data:${mime};base64,${b.data}" class="tool-screenshot" style="max-width:100%;height:auto;border-radius:4px;display:block;margin:4px 0;" />`
          )
        }
      }
      return parts.join('\n')
    }
    return content ? JSON.stringify(content) : ''
  }

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
    handshakeReady = createReadinessGate()

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

          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            const nonce = msg.payload?.nonce
            if (nonce) connectNonce = nonce

            try {
              const id = getIdentity()
              const deviceId = deriveDeviceId(id.publicKey)
              const pubKeyB64 = publicKeyBase64Url(id.publicKey)
              const storedToken = currentConfig.gatewayToken || getDeviceToken(deviceId) || ''
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
              pending.set(reqId, {
                resolve: (result) => {
                  if (settled) return
                  settled = true

                  const auth = (result as any)?.auth
                  if (auth?.deviceToken) {
                    saveDeviceToken(deviceId, auth.deviceToken)
                  }

                  handshakeReady.ready = true
                  handshakeReady.resolve()
                  setStatus('connected')
                  resolve()
                },
                reject: (err) => {
                  if (settled) return
                  settled = true
                  handshakeReady.reject(err)
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
                    minProtocol: 4,
                    maxProtocol: 4,
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
                handshakeReady.reject(err as Error)
                reject(err as Error)
              }
            }
            return
          }

          handleMessage(raw)
        })

        ws.on('close', () => {
          if (state.destroyed) return
          pending.forEach((p) => p.reject(new Error('Connection closed')))
          pending.clear()
          if (!settled) {
            settled = true
            const closeError = new Error('Connection closed before handshake')
            handshakeReady.reject(closeError)
            setStatus('disconnected', 'Connection closed before handshake', 'server_down')
            reject(closeError)
          } else {
            setStatus('disconnected', 'Connection lost')
          }
          scheduleReconnect()
        })

        ws.on('error', (err: Error) => {
          if (!settled) {
            settled = true
            handshakeReady.reject(err)
            const errorType = err.message?.includes('certificate') ? 'cert_error' : 'server_down'
            setStatus('disconnected', err.message, errorType)
            reject(err)
          }
        })
      } catch (err) {
        handshakeReady.reject(err as Error)
        setStatus('disconnected')
        reject(err as Error)
      }
    })
  }

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
    if (!handshakeReady.ready) {
      handshakeReady.reject(new Error('Backend disconnected'))
      handshakeReady = createReadinessGate()
    }
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
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

  // ── Models cache for listAvailableModels ──
  let modelsCache: { models: string[]; defaultModel: string | null; ts: number } | null = null
  const MODELS_CACHE_TTL = 30_000

  async function listAvailableModels(): Promise<{ models: string[]; defaultModel: string | null }> {
    if (modelsCache && Date.now() - modelsCache.ts < MODELS_CACHE_TTL) {
      return { models: modelsCache.models, defaultModel: modelsCache.defaultModel }
    }
    try {
      const raw = readFileSync(paths.openClawConfigPath, 'utf-8')
      const config = JSON.parse(raw)
      const modelsObj = config?.agents?.defaults?.models ?? {}
      const models = Object.keys(modelsObj)
      const defaultModel = config?.agents?.defaults?.model?.primary ?? null
      modelsCache = { models, defaultModel, ts: Date.now() }
      return { models, defaultModel }
    } catch {
      return { models: [], defaultModel: null }
    }
  }

  function readSessionsJson(): Record<string, any> {
    try {
      return JSON.parse(readFileSync(paths.sessionsJsonPath, 'utf-8'))
    } catch {
      return {}
    }
  }

  async function listSessions(filter?: { kind?: SessionKind; parentKey?: string }): Promise<SessionSummary[]> {
    const data = readSessionsJson()
    const out: SessionSummary[] = []
    for (const [fullKey, meta] of Object.entries(data) as [string, any][]) {
      const kind = classifySessionKey(fullKey)
      if (filter?.kind && filter.kind !== kind) continue
      const parentKey = meta?.spawnedBy as string | undefined
      if (filter?.parentKey && parentKey !== filter.parentKey) continue
      out.push({
        key: fullKey,
        backendSessionId: meta?.sessionId,
        kind,
        label: meta?.label,
        lastActivity: meta?.updatedAt ?? meta?.createdAt,
        agentStatus: meta?.status,
        parentKey,
        task: meta?.task
      })
    }
    return out
  }

  async function listSubagents(parentKey?: string): Promise<SubagentSummary[]> {
    const data = readSessionsJson()
    const out: SubagentSummary[] = []
    for (const [fullKey, meta] of Object.entries(data) as [string, any][]) {
      if (!fullKey.includes(':subagent:')) continue
      if (!meta?.spawnedBy) continue
      if (parentKey && meta.spawnedBy !== parentKey) continue
      out.push({
        sessionKey: fullKey,
        label: meta.label ?? fullKey.split(':subagent:')[1]?.slice(0, 8) ?? 'Subagent',
        status: meta.status ?? 'idle',
        lastActivity: meta.updatedAt,
        task: meta.task ?? meta.label
      })
    }
    out.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    return out
  }

  async function getSessionMeta(sessionKey: string): Promise<SessionMeta | null> {
    const data = readSessionsJson()
    const meta = data[sessionKey]
    if (!meta) return null
    return {
      sessionKey,
      model: meta.model ?? null,
      modelProvider: meta.modelProvider ?? null,
      contextTokens: meta.contextTokens ?? null,
      totalTokens: meta.totalTokens ?? 0,
      inputTokens: meta.inputTokens ?? 0,
      outputTokens: meta.outputTokens ?? 0,
      compactionCount: meta.compactionCount ?? 0,
      thinkingLevel: meta.thinkingLevel ?? null,
      task: meta.task ?? null,
      label: meta.label ?? null,
      parentKey: meta.spawnedBy ?? null
    }
  }

  async function setSessionModel(sessionKey: string, provider: string, model: string): Promise<void> {
    const data = readSessionsJson()
    if (!data[sessionKey]) return
    data[sessionKey].modelProvider = provider
    data[sessionKey].model = model
    const tmp = paths.sessionsJsonPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    const fs = await import('node:fs')
    fs.renameSync(tmp, paths.sessionsJsonPath)
  }

  async function getContextBudget(_sessionKey: string): Promise<ContextBudget | null> {
    const gatewayUrl = currentConfig.gatewayUrl
    const token = currentConfig.gatewayToken
    const httpUrl = gatewayUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/api/context')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (token) headers['Authorization'] = `Bearer ${token}`
      const res = await fetch(httpUrl, { headers, signal: controller.signal })
      clearTimeout(timeout)
      if (res.ok) {
        const json = (await res.json()) as any
        return {
          source: 'gateway',
          generatedAt: Date.now(),
          ...json.report,
          session: json.session,
          fileContents: json.fileContents,
          disabledTools: json.disabledTools,
          disabledSkills: json.disabledSkills
        } as ContextBudget
      }
    } catch {
      /* gateway unavailable */
    }
    return null
  }

  function getDeviceInfo(): DeviceInfo {
    const id = getIdentity()
    const deviceId = deriveDeviceId(id.publicKey)
    return {
      backendKind: KIND,
      deviceId,
      publicKey: id.publicKey,
      connectionStatus: state.connectionStatus,
      gatewayUrl: currentConfig.gatewayUrl,
      reconnectAttempt: state.reconnectAttempt
    }
  }

  async function spawnSubagent(parentSessionKey: string, opts: SpawnSubagentOptions): Promise<string> {
    const result = (await request('subagent.spawn', {
      parentSessionKey,
      task: opts.task,
      label: opts.label,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      toolAllowlist: opts.toolAllowlist,
      timeoutMs: opts.timeoutMs
    }).catch(() => null)) as { sessionKey?: string } | null
    if (!result?.sessionKey) throw new Error('OpenClaw: subagent spawn not supported via RPC')
    return result.sessionKey
  }

  const capabilities = (): BackendCapabilities => ({
    subagents: 'native',
    cron: 'backend-managed',
    steering: false,
    followUp: false,
    compaction: 'automatic-only',
    toolStreaming: true,
    deviceIdentity: true,
    multiProvider: true
  })

  const cronBridge = createOpenClawCronBridge({
    async list(includeDisabled = false) {
      try {
        const result = (await request('cron.list', { includeDisabled })) as { jobs?: any[] }
        return (result?.jobs ?? []) as any
      } catch (err: any) {
        console.error('[openclaw] cron.list failed:', err.message)
        return []
      }
    },
    async runs(jobId?: string) {
      try {
        const result = (await request('cron.runs', {
          scope: jobId ? 'job' : 'all',
          id: jobId,
          limit: 20
        })) as { entries?: any[] }
        return (result?.entries ?? []) as any
      } catch (err: any) {
        console.error('[openclaw] cron.runs failed:', err.message)
        return []
      }
    },
    async update(id: string, patch: Record<string, unknown>) {
      return await request('cron.update', { jobId: id, patch })
    },
    async remove(id: string) {
      await request('cron.remove', { jobId: id })
    }
  })

  async function listGatewaySessions() {
    try {
      const result = (await request('sessions.list', { limit: 200 })) as { sessions?: any[] }
      return (result?.sessions ?? []).map((s: any) => ({
        key: s.key ?? s.sessionKey ?? '',
        label: s.label,
        kind: s.kind,
        lastActivity: s.lastActivity ?? s.updatedAt,
        agentStatus: s.agentStatus ?? s.status
      }))
    } catch (err: any) {
      console.error('[openclaw] sessions.list failed:', err.message)
      return []
    }
  }

  const backend: OpenClawBackend = {
    kind: KIND,
    paths,
    cronBridge,

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
      const filePath = openClawGetSessionFile(paths, sessionKey)
      if (filePath) {
        try {
          const stat = statSync(filePath)
          const cached = historyCache.get(sessionKey)

          if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
            return { turns: cached.turns, hasMore: cached.hasMore }
          }

          const { messages, hasMore } = openClawReadRecent(filePath, 2000)
          if (messages.length > 0) {
            const turns = parseTurns(messages)

            let effectiveHasMore = hasMore
            if (!hasMore) {
              const allFiles = openClawGetAllSessionFiles(paths, sessionKey)
              if (allFiles.length > 1 && allFiles[allFiles.length - 1] === filePath) {
                effectiveHasMore = true
              }
            }

            historyCache.set(sessionKey, {
              turns,
              hasMore: effectiveHasMore,
              mtime: stat.mtimeMs,
              size: stat.size
            })
            if (historyCache.size > HISTORY_CACHE_MAX) {
              const firstKey = historyCache.keys().next().value
              if (firstKey) historyCache.delete(firstKey)
            }

            return { turns, hasMore: effectiveHasMore }
          }
        } catch (err) {
          /* fall through to RPC */
        }
      }

      const result = (await request('chat.history', { sessionKey, limit: 200 })) as { messages?: any[] }
      const raw = result?.messages ?? []
      return { turns: parseTurns(raw), hasMore: false }
    },

    async getFullHistory(sessionKey: string): Promise<ParsedTurn[]> {
      const allFiles = openClawGetAllSessionFiles(paths, sessionKey)
      const currentFile = openClawGetSessionFile(paths, sessionKey)

      let allMessages: any[] = []

      for (const f of allFiles) {
        if (f === currentFile) continue
        allMessages.push(...openClawReadAll(f))
      }

      if (currentFile) {
        try {
          const { messages } = openClawReadRecent(currentFile, 100000)
          allMessages.push(...messages)
        } catch {
          /* ignore */
        }
      }

      if (allMessages.length > 0) {
        return parseTurns(allMessages)
      }

      const result = (await request('chat.history', { sessionKey, limit: 10000 })) as { messages?: any[] }
      return parseTurns(result?.messages ?? [])
    },

    on: emitter.on,
    off: emitter.off,

    capabilities,
    listSessions,
    listSubagents,
    getSessionMeta,
    setSessionModel,
    listAvailableModels,
    getContextBudget,
    spawnSubagent,
    restart: restartOpenClawGateway,
    getDeviceInfo,
    getSessionFilePath(sessionKey: string) {
      return openClawGetSessionFile(paths, sessionKey)
    },
    listGatewaySessions
  }

  return backend
}
