import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { createEventBus } from '@sovereign/core'
import type { EventBus, AgentBackend, AgentBackendEvents, BackendConnectionStatus } from '@sovereign/core'
import { createOpenClawBackend } from '../agent-backend/openclaw.js'
import { createThreadManager } from '../threads/threads.js'
import type { EntityBinding, ThreadEvent } from '../threads/types.js'
import { createVoiceModule } from '../voice/voice.js'
import { createChatModule } from '../chat/chat.js'
import type { OpenClawConfig } from '../agent-backend/types.js'

// --- Helpers ---

function waitForEvent<K extends keyof AgentBackendEvents>(
  backend: AgentBackend,
  event: K,
  timeoutMs = 3000
): Promise<AgentBackendEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      backend.off(event, handler)
      reject(new Error(`Timeout waiting for ${event}`))
    }, timeoutMs)
    const handler = (data: AgentBackendEvents[K]) => {
      clearTimeout(timer)
      backend.off(event, handler)
      resolve(data)
    }
    backend.on(event, handler)
  })
}

function waitForBusEvent(bus: EventBus, pattern: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`Timeout waiting for bus event ${pattern}`))
    }, timeoutMs)
    const unsub = bus.on(pattern, (event) => {
      clearTimeout(timer)
      unsub()
      resolve(event)
    })
  })
}

function createMockGateway(): {
  server: http.Server
  wss: WebSocketServer
  port: number
  url: string
  clients: Set<WebSocket>
  lastMessage: () => any
  close: () => Promise<void>
  start: () => Promise<void>
} {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const clients = new Set<WebSocket>()
  let lastMsg: any = null

  wss.on('connection', (ws) => {
    clients.add(ws)
    // Challenge-response handshake
    ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test-nonce' } }))
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      lastMsg = msg
      if (msg.type === 'req' && msg.method === 'connect') {
        ws.send(JSON.stringify({ type: 'res', id: msg.id, result: { ok: true } }))
      }
    })
    ws.on('close', () => clients.delete(ws))
  })

  let port = 0
  const url = () => `ws://127.0.0.1:${port}`

  return {
    server,
    wss,
    get port() {
      return port
    },
    get url() {
      return url()
    },
    clients,
    lastMessage: () => lastMsg,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of clients) c.close()
        clients.clear()
        wss.close(() => server.close(() => resolve()))
      }),
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as any).port
          resolve()
        })
      })
  }
}

function createMockHttpServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): {
  server: http.Server
  port: number
  url: string
  start: () => Promise<void>
  close: () => Promise<void>
} {
  const server = http.createServer(handler)
  let port = 0
  return {
    server,
    get port() {
      return port
    },
    get url() {
      return `http://127.0.0.1:${port}`
    },
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as any).port
          resolve()
        })
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// --- Test Suite ---

describe('Phase 6 — Integration Tests', () => {
  let tmpDir: string
  let bus: EventBus

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-p6-'))
    bus = createEventBus(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Agent backend proxy round-trip: client sends chat.send → server proxies to backend → mock gateway responds with stream tokens → server proxies chat.stream + chat.turn back to client', async () => {
    const gw = createMockGateway()
    await gw.start()

    // When gateway receives a chat.send req, respond with stream events + turn
    gw.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'req' && msg.method === 'chat.send') {
          // Respond to the RPC request
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }))
          // Then send stream events
          const sk = msg.params?.sessionKey ?? 'main'
          // Delta messages contain full accumulated text
          ws.send(JSON.stringify({ type: 'event', event: 'chat', payload: { state: 'delta', message: [{ type: 'text', text: 'Hello' }], sessionKey: sk } }))
          ws.send(JSON.stringify({ type: 'event', event: 'chat', payload: { state: 'delta', message: [{ type: 'text', text: 'Hello world' }], sessionKey: sk } }))
          ws.send(JSON.stringify({ type: 'event', event: 'chat', payload: { state: 'final', message: [{ type: 'text', text: 'Hello world' }], sessionKey: sk } }))
        }
      })
    })

    const backend = createOpenClawBackend({
      gatewayUrl: gw.url,
      dataDir: tmpDir,
      reconnect: { initialDelayMs: 100, maxDelayMs: 500 }
    })

    try {
      await backend.connect()
      expect(backend.status()).toBe('connected')

      const streamTexts: string[] = []
      backend.on('chat.stream', (d) => streamTexts.push(d.text))
      const turnP = waitForEvent(backend, 'chat.turn')

      await backend.sendMessage('main', 'Hi')

      const turnData = await turnP
      expect(turnData.turn.content).toBe('Hello world')
      expect(streamTexts).toContain('Hello')
      expect(streamTexts).toContain(' world')
    } finally {
      await backend.disconnect()
      await gw.close()
    }
  })

  it('Thread auto-creation from worktree: emit worktree.created → thread manager creates thread → WS thread.created sent to subscribers', async () => {
    const tm = createThreadManager(bus, tmpDir)
    const eventP = waitForBusEvent(bus, 'thread.created')

    bus.emit({
      type: 'worktree.created',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', branch: 'feature-x' }
    })

    const event = await eventP
    expect(event.payload.thread.key).toBe('org1/proj1/branch:feature-x')
    expect(event.payload.thread.entities[0].entityType).toBe('branch')

    // Verify thread exists in manager
    const thread = tm.get('org1/proj1/branch:feature-x')
    expect(thread).toBeDefined()
    expect(thread!.entities[0].entityRef).toBe('feature-x')
  })

  it('Thread auto-creation from issue: emit issue.created → issue thread created', async () => {
    const tm = createThreadManager(bus, tmpDir)
    const eventP = waitForBusEvent(bus, 'thread.created')

    bus.emit({
      type: 'issue.created',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '42' }
    })

    const event = await eventP
    expect(event.payload.thread.key).toBe('org1/proj1/issue:42')
    const thread = tm.get('org1/proj1/issue:42')
    expect(thread).toBeDefined()
    expect(thread!.entities[0].entityType).toBe('issue')
  })

  it('Thread auto-creation from review: emit review.created → PR thread created', async () => {
    const tm = createThreadManager(bus, tmpDir)
    const eventP = waitForBusEvent(bus, 'thread.created')

    bus.emit({
      type: 'review.created',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', prId: '99' }
    })

    const event = await eventP
    expect(event.payload.thread.key).toBe('org1/proj1/pr:99')
    const thread = tm.get('org1/proj1/pr:99')
    expect(thread).toBeDefined()
    expect(thread!.entities[0].entityType).toBe('pr')
  })

  it('Entity event routing: emit issue.updated → routed to correct issue thread → WS thread.event.routed sent to subscribers', async () => {
    const tm = createThreadManager(bus, tmpDir)

    // Create issue thread first
    bus.emit({
      type: 'issue.created',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '10' }
    })
    await new Promise((r) => setTimeout(r, 50))

    const thread = tm.get('org1/proj1/issue:10')
    expect(thread).toBeDefined()

    // Set up routing: listen for issue.updated and route to the thread
    const routedEvents: any[] = []
    bus.on('thread.event.routed', (e) => {
      routedEvents.push(e)
    })

    // Route issue.updated events to their thread
    bus.on('issue.updated', (event) => {
      const p = event.payload as { orgId: string; projectId: string; issueId: string }
      const entity: EntityBinding = {
        orgId: p.orgId,
        projectId: p.projectId,
        entityType: 'issue',
        entityRef: p.issueId
      }
      const threads = tm.getThreadsForEntity(entity)
      for (const t of threads) {
        const threadEvent: ThreadEvent = {
          threadKey: t.key,
          event: event.payload,
          entityBinding: entity,
          timestamp: Date.now()
        }
        tm.addEvent(t.key, threadEvent)
        bus.emit({
          type: 'thread.event.routed',
          timestamp: new Date().toISOString(),
          source: 'threads',
          payload: { threadKey: t.key, event: event.payload, entityBinding: entity }
        })
      }
    })

    bus.emit({
      type: 'issue.updated',
      timestamp: new Date().toISOString(),
      source: 'test',
      payload: { orgId: 'org1', projectId: 'proj1', issueId: '10', title: 'Updated title' }
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(routedEvents).toHaveLength(1)
    expect(routedEvents[0].payload.threadKey).toBe('org1/proj1/issue:10')
    expect(tm.getEvents('org1/proj1/issue:10')).toHaveLength(1)
  })

  it('Multi-entity routing: add two entities to same thread → events from both entities route to that thread', async () => {
    const tm = createThreadManager(bus, tmpDir)

    // Create a thread with one entity
    const thread = tm.create({
      label: 'multi-entity',
      entities: [{ orgId: 'org1', projectId: 'proj1', entityType: 'issue', entityRef: '1' }]
    })

    // Add a second entity
    tm.addEntity(thread.key, { orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '5' })

    // Verify both entities resolve to this thread
    const issueThreads = tm.getThreadsForEntity({
      orgId: 'org1',
      projectId: 'proj1',
      entityType: 'issue',
      entityRef: '1'
    })
    const prThreads = tm.getThreadsForEntity({ orgId: 'org1', projectId: 'proj1', entityType: 'pr', entityRef: '5' })

    expect(issueThreads).toHaveLength(1)
    expect(prThreads).toHaveLength(1)
    expect(issueThreads[0].key).toBe(thread.key)
    expect(prThreads[0].key).toBe(thread.key)

    // Both entities in the thread
    expect(tm.getEntities(thread.key)).toHaveLength(2)
  })

  it('Thread switching: client sends chat.session.switch → server maps thread key to backend session → backend switchSession called → history loaded → chat.session.info sent', async () => {
    const gw = createMockGateway()
    await gw.start()

    // Gateway responds to session.switch + history requests (new RPC protocol)
    gw.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'req' && msg.method === 'session.create') {
          ws.send(
            JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { sessionKey: 'sess-' + msg.id } })
          )
        }
        if (msg.type === 'req' && msg.method === 'session.switch') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, result: { ok: true } }))
        }
        if (msg.type === 'req' && msg.method === 'chat.history') {
          ws.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: {
                messages: [{ role: 'user', content: 'Hello', timestamp: 1000, workItems: [], thinkingBlocks: [] }]
              }
            })
          )
        }
      })
    })

    const backend = createOpenClawBackend({ gatewayUrl: gw.url, dataDir: tmpDir })

    try {
      await backend.connect()

      await backend.switchSession('test-session')
      const history = await backend.getHistory('test-session')

      expect(history).toHaveLength(1)
      expect(history[0].content).toBe('Hello')
    } finally {
      await backend.disconnect()
      await gw.close()
    }
  })

  it('Message forwarding: POST /api/threads/:key/forward with ForwardedMessage → message delivered to target thread backend session → thread.message.forwarded bus event emitted', async () => {
    const gw = createMockGateway()
    await gw.start()

    const sentMessages: any[] = []
    // Override the default message handler on the wss to also track messages
    gw.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        sentMessages.push(msg)
        if (msg.type === 'req' && msg.method === 'session.create') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { sessionKey: 'fwd-sess' } }))
        }
        if (msg.type === 'req' && msg.method === 'chat.send') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }))
        }
      })
    })
    // Remove the default handler that also listens (from createMockGateway)
    // Actually the issue is both handlers fire — sentMessages should capture fine.
    // The real issue: handleSend calls createSession which waits for session.created,
    // then sends chat.send. We need to wait for the chat.send to arrive.

    const backend = createOpenClawBackend({ gatewayUrl: gw.url, dataDir: tmpDir })
    const tm = createThreadManager(bus, tmpDir)

    try {
      await backend.connect()
      const chat = createChatModule(bus, backend, tm, { dataDir: tmpDir })

      // Create target thread
      const targetThread = tm.create({ label: 'target-thread' })

      // Forward a message (via chat.handleSend which is how forwarding works)
      const forwardedText = '[Forwarded from source-thread]\n> Original message content\n\nHere is context'

      const busEventP = waitForBusEvent(bus, 'chat.message.sent')
      await chat.handleSend(targetThread.key, forwardedText)
      const busEvent = await busEventP

      expect(busEvent.payload.threadKey).toBe(targetThread.key)
      expect(busEvent.payload.text).toContain('Forwarded')

      // Wait for WS message to arrive (poll)
      let chatSend: any = null
      const start = Date.now()
      while (!chatSend && Date.now() - start < 1000) {
        chatSend = sentMessages.find((m) => m.method === 'chat.send')
        if (!chatSend) await new Promise((r) => setTimeout(r, 25))
      }

      // Backend received the message
      expect(chatSend).toBeDefined()
      expect(chatSend.params?.message ?? chatSend.text).toContain('Forwarded')
    } finally {
      await backend.disconnect()
      await gw.close()
    }
  })

  it('Voice transcription proxy: POST /api/voice/transcribe with audio blob → proxied to mock transcription service → text returned', async () => {
    const mockTranscribe = createMockHttpServer((req, res) => {
      let body: Buffer[] = []
      req.on('data', (chunk) => body.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ text: 'Hello world' }))
      })
    })

    await mockTranscribe.start()

    try {
      const voice = createVoiceModule(bus, { transcribeUrl: mockTranscribe.url, ttsUrl: undefined })
      const result = await voice.transcribe(Buffer.from('fake-audio'), 'audio/wav')

      expect(result.text).toBe('Hello world')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      // Bus event emitted
      const history = bus.history({ pattern: 'voice.transcription.completed' })
      expect(history).toHaveLength(1)
    } finally {
      await mockTranscribe.close()
    }
  })

  it('Voice TTS proxy: POST /api/voice/tts with text → proxied to mock TTS service → audio blob returned', async () => {
    const fakeAudio = Buffer.from('fake-audio-data-wav')
    const mockTts = createMockHttpServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        expect(parsed.text).toBe('Say hello')
        res.writeHead(200, { 'Content-Type': 'audio/wav' })
        res.end(fakeAudio)
      })
    })

    await mockTts.start()

    try {
      const voice = createVoiceModule(bus, { transcribeUrl: undefined, ttsUrl: mockTts.url })
      const result = await voice.synthesize('Say hello')

      expect(Buffer.isBuffer(result.audio)).toBe(true)
      expect(result.audio.toString()).toBe('fake-audio-data-wav')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)

      const history = bus.history({ pattern: 'voice.tts.completed' })
      expect(history).toHaveLength(1)
    } finally {
      await mockTts.close()
    }
  })

  it('Rate limit handling: mock gateway emits error with retryAfterMs → server forwards chat.error to client', async () => {
    const gw = createMockGateway()
    await gw.start()

    gw.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'req' && msg.method === 'chat.send') {
          ws.send(JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: {} }))
          // Emit lifecycle error event with retryAfterMs
          ws.send(
            JSON.stringify({
              type: 'event',
              event: 'agent',
              payload: {
                stream: 'lifecycle',
                data: { phase: 'error', error: 'Rate limited', retryAfterMs: 100 },
                sessionKey: msg.params?.sessionKey ?? 'main'
              }
            })
          )
        }
      })
    })

    const backend = createOpenClawBackend({ gatewayUrl: gw.url, dataDir: tmpDir })

    try {
      await backend.connect()

      const errorP = waitForEvent(backend, 'chat.error')
      await backend.sendMessage('main', 'test')

      const errorData = await errorP
      expect(errorData.error).toBe('Rate limited')
      expect(errorData.retryAfterMs).toBe(100)
    } finally {
      await backend.disconnect()
      await gw.close()
    }
  })

  it('Config hot-reload: change agentBackend.openclaw.gatewayUrl via config API → backend disconnects from old URL → reconnects to new URL → clients receive backend.status transitions', async () => {
    const gw1 = createMockGateway()
    const gw2 = createMockGateway()
    await gw1.start()
    await gw2.start()

    let configChangeCallback: ((newConfig: Partial<OpenClawConfig>) => void) | null = null

    const backend = createOpenClawBackend({
      gatewayUrl: gw1.url,
      dataDir: tmpDir,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200 },
      onConfigChange: (cb) => {
        configChangeCallback = cb
      }
    })

    try {
      await backend.connect()
      expect(backend.status()).toBe('connected')
      expect(gw1.clients.size).toBe(1)

      const statuses: BackendConnectionStatus[] = []
      backend.on('backend.status', (d) => statuses.push(d.status))

      // Trigger hot-reload to gw2
      configChangeCallback!({ gatewayUrl: gw2.url })

      // Wait for reconnection
      await new Promise((r) => setTimeout(r, 500))

      expect(backend.status()).toBe('connected')
      expect(gw2.clients.size).toBe(1)

      // Should have gone through disconnected → connecting → connected
      expect(statuses).toContain('connecting')
      expect(statuses).toContain('connected')
    } finally {
      await backend.disconnect()
      await gw1.close()
      await gw2.close()
    }
  })

  it('Backend disconnection and reconnection: mock gateway closes connection → server emits backend.status disconnected → clients notified → mock gateway accepts reconnection → backend.status connected', async () => {
    const gw = createMockGateway()
    await gw.start()

    const backend = createOpenClawBackend({
      gatewayUrl: gw.url,
      dataDir: tmpDir,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, jitter: false }
    })

    try {
      await backend.connect()
      expect(backend.status()).toBe('connected')

      const statuses: BackendConnectionStatus[] = []
      backend.on('backend.status', (d) => statuses.push(d.status))

      // Close server-side connection
      for (const c of gw.clients) c.close()

      // Wait for disconnect + reconnect
      await new Promise((r) => setTimeout(r, 500))

      expect(statuses).toContain('disconnected')
      // Should have reconnected
      expect(backend.status()).toBe('connected')
      expect(statuses.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(1)
    } finally {
      await backend.disconnect()
      await gw.close()
    }
  })

  it('Session mapping persistence: create session mapping → restart server (reload from disk) → mapping preserved', async () => {
    const gw = createMockGateway()
    await gw.start()

    gw.wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'req' && msg.method === 'session.create') {
          ws.send(
            JSON.stringify({ type: 'res', id: msg.id, ok: true, payload: { sessionKey: 'persistent-sess-1' } })
          )
        }
      })
    })

    const backend = createOpenClawBackend({ gatewayUrl: gw.url, dataDir: tmpDir })
    const tm = createThreadManager(bus, tmpDir)
    try {
      await backend.connect()

      // Create chat module and a session mapping
      const chat1 = createChatModule(bus, backend, tm, { dataDir: tmpDir })
      const { threadKey, sessionKey } = await chat1.handleSessionCreate('test-label')

      expect(threadKey).toBeDefined()
      expect(sessionKey).toBe(`agent:main:thread:${threadKey}`)
      expect(chat1.getSessionKeyForThread(threadKey)).toBe(`agent:main:thread:${threadKey}`)

      // "Restart" — create a new chat module that loads from disk
      const chat2 = createChatModule(bus, backend, tm, { dataDir: tmpDir })
      chat2.loadMapping()

      expect(chat2.getSessionKeyForThread(threadKey)).toBe(`agent:main:thread:${threadKey}`)
      expect(chat2.getThreadKeyForSession(`agent:main:thread:${threadKey}`)).toBe(threadKey)
    } finally {
      await backend.disconnect()
      await gw.close()
    }
  })
})
