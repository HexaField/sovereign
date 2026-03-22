// Chat Module — WS proxy, session mapping, bus integration

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { EventBus, ModuleStatus, AgentBackend, AgentBackendEvents } from '@sovereign/core'
import type { WsHandler } from '../ws/handler.js'
import type { ThreadManager } from '../threads/types.js'
import { deriveSessionKey } from './derive-session-key.js'

export interface ChatModule {
  status(): ModuleStatus
  handleSend(threadKey: string, text: string, attachments?: Buffer[]): Promise<void>
  handleAbort(threadKey: string): Promise<void>
  handleHistory(threadKey: string, deviceId: string): Promise<void>
  handleSessionSwitch(threadKey: string): Promise<void>
  handleSessionCreate(label?: string): Promise<{ threadKey: string; sessionKey: string }>
  getSessionKeyForThread(threadKey: string): string | undefined
  getThreadKeyForSession(sessionKey: string): string | undefined
  loadMapping(): void
}

export function createChatModule(
  bus: EventBus,
  backend: AgentBackend,
  threadManager: ThreadManager,
  options?: { dataDir?: string; wsHandler?: WsHandler }
): ChatModule {
  const dataDir = options?.dataDir ?? '.'
  const wsHandler = options?.wsHandler

  // Bidirectional mapping: threadKey <-> sessionKey
  const threadToSession = new Map<string, string>()
  const sessionToThread = new Map<string, string>()

  const mappingPath = path.join(dataDir, 'chat', 'session-map.json')

  function persistMapping(): void {
    const dir = path.dirname(mappingPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const data = JSON.stringify(Object.fromEntries(threadToSession))
    const tmpPath = mappingPath + '.tmp'
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, mappingPath)
  }

  function loadMapping(): void {
    try {
      const data = fs.readFileSync(mappingPath, 'utf-8')
      const obj = JSON.parse(data) as Record<string, string>
      for (const [tk, sk] of Object.entries(obj)) {
        threadToSession.set(tk, sk)
        sessionToThread.set(sk, tk)
      }
    } catch {
      // No file or invalid — start empty
    }
  }

  // Load on creation
  loadMapping()

  function setMapping(threadKey: string, sessionKey: string): void {
    threadToSession.set(threadKey, sessionKey)
    sessionToThread.set(sessionKey, threadKey)
    persistMapping()
  }

  // --- Live state cache for replay on reconnect ---
  const currentStatus = new Map<string, string>()
  const currentWork = new Map<string, any[]>()
  const currentStreamText = new Map<string, string>()

  // Proxy backend events to WS subscribers
  const backendEvents: (keyof AgentBackendEvents)[] = [
    'chat.stream',
    'chat.turn',
    'chat.status',
    'chat.work',
    'chat.compacting',
    'chat.error',
    'session.info'
  ]

  for (const eventName of backendEvents) {
    backend.on(eventName, (data: Record<string, unknown>) => {
      const sessionKey = data.sessionKey as string | undefined
      const threadKey = sessionKey ? sessionToThread.get(sessionKey) : undefined

      // Cache live state per thread for replay on reconnect
      if (threadKey) {
        if (eventName === 'chat.status') {
          currentStatus.set(threadKey, data.status as string)
        } else if (eventName === 'chat.work') {
          const items = currentWork.get(threadKey) ?? []
          items.push(data.work)
          currentWork.set(threadKey, items)
        } else if (eventName === 'chat.stream') {
          const prev = currentStreamText.get(threadKey) ?? ''
          currentStreamText.set(threadKey, prev + (data.text as string))
        } else if (eventName === 'chat.turn') {
          // Turn complete — clear cached state
          currentStatus.delete(threadKey)
          currentWork.delete(threadKey)
          currentStreamText.delete(threadKey)
        }
      }

      // Map WS message type
      const wsType = eventName === 'session.info' ? 'chat.session.info' : eventName

      if (wsHandler && threadKey) {
        wsHandler.broadcastToChannel('chat', {
          type: wsType,
          ...data,
          threadKey
        })
      }

      // Emit bus event for chat.turn
      if (eventName === 'chat.turn' && threadKey) {
        bus.emit({
          type: 'chat.turn.completed',
          timestamp: new Date().toISOString(),
          source: 'chat',
          payload: { threadKey, turn: data.turn }
        })
      }
    })
  }

  // Also proxy backend.status
  backend.on('backend.status', (data) => {
    if (wsHandler) {
      wsHandler.broadcastToChannel('chat', {
        type: 'backend.status',
        ...data
      })
    }
  })

  // deriveSessionKey is imported at module level from ./derive-session-key.js

  async function handleSend(threadKey: string, text: string, attachments?: Buffer[]): Promise<void> {
    let sessionKey = threadToSession.get(threadKey)
    if (!sessionKey) {
      sessionKey = deriveSessionKey(threadKey)
      setMapping(threadKey, sessionKey)
    }
    await backend.sendMessage(sessionKey, text, attachments)
    bus.emit({
      type: 'chat.message.sent',
      timestamp: new Date().toISOString(),
      source: 'chat',
      payload: { threadKey, text, timestamp: Date.now() }
    })
  }

  async function handleAbort(threadKey: string): Promise<void> {
    const sessionKey = threadToSession.get(threadKey)
    if (sessionKey) {
      await backend.abort(sessionKey)
    }
  }

  async function handleHistory(threadKey: string, deviceId: string): Promise<void> {
    let sessionKey = threadToSession.get(threadKey)
    if (!sessionKey) {
      // Derive and persist the session key for threads not yet in the map
      sessionKey = deriveSessionKey(threadKey)
      setMapping(threadKey, sessionKey)
    }
    let history: any[] = []
    try {
      history = await backend.getHistory(sessionKey)
    } catch {
      // timeout or connection error — return empty history
    }
    if (wsHandler) {
      wsHandler.sendTo(deviceId, { type: 'chat.session.info', threadKey, sessionKey, history })

      // Replay cached live state so reconnecting clients see in-progress work
      const status = currentStatus.get(threadKey)
      if (status && status !== 'idle') {
        wsHandler.sendTo(deviceId, { type: 'chat.status', threadKey, status })
        const work = currentWork.get(threadKey)
        if (work?.length) {
          for (const item of work) {
            wsHandler.sendTo(deviceId, { type: 'chat.work', threadKey, work: item })
          }
        }
        const text = currentStreamText.get(threadKey)
        if (text) {
          wsHandler.sendTo(deviceId, { type: 'chat.stream', threadKey, text, replay: true })
        }
      }
    }
  }

  async function handleSessionSwitch(threadKey: string): Promise<void> {
    const sessionKey = threadToSession.get(threadKey)
    if (sessionKey) {
      await backend.switchSession(sessionKey)
    }
  }

  async function handleSessionCreate(label?: string): Promise<{ threadKey: string; sessionKey: string }> {
    const thread = threadManager.create({ label })
    const sessionKey = deriveSessionKey(thread.key)
    setMapping(thread.key, sessionKey)
    return { threadKey: thread.key, sessionKey }
  }

  return {
    status: () => ({ name: 'chat', status: 'ok' }),
    handleSend,
    handleAbort,
    handleHistory,
    handleSessionSwitch,
    handleSessionCreate,
    getSessionKeyForThread: (tk: string) => threadToSession.get(tk),
    getThreadKeyForSession: (sk: string) => sessionToThread.get(sk),
    loadMapping
  }
}
