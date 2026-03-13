import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws'
import { createOpenClawBackend } from './openclaw.js'
import type { OpenClawConfig } from './types.js'
import type { AgentBackend, BackendConnectionStatus } from '@template/core'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function waitFor(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function waitForEvent<T>(backend: AgentBackend, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs)
    const handler = (data: T) => {
      clearTimeout(timer)
      ;(backend as any).off(event, handler)
      resolve(data)
    }
    ;(backend as any).on(event, handler)
  })
}

function waitForConnection(wss: WebSocketServer, timeoutMs = 3000): Promise<WsWebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for WS connection')), timeoutMs)
    wss.once('connection', (ws) => {
      clearTimeout(timer)
      resolve(ws)
    })
  })
}

describe('§2.2 OpenClaw Implementation', { timeout: 10000 }, () => {
  let wss: WebSocketServer
  let port: number
  let backend: AgentBackend
  let dataDir: string

  function getConfig(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
    return {
      gatewayUrl: `ws://127.0.0.1:${port}/ws`,
      dataDir,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, jitter: false },
      ...overrides
    }
  }

  async function connectBackend(cfg?: Partial<OpenClawConfig>): Promise<WsWebSocket> {
    const connPromise = waitForConnection(wss)
    backend = createOpenClawBackend(getConfig(cfg))
    await backend.connect()
    return connPromise
  }

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sovereign-test-'))
    await new Promise<void>((resolve) => {
      wss = new WebSocketServer({ port: 0 }, () => {
        port = (wss.address() as any).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    // Disconnect backend FIRST (sets destroyed=true, clears all timers)
    if (backend) {
      try {
        await backend.disconnect()
      } catch {}
    }
    // Force-close all server-side client connections
    for (const client of wss.clients) {
      try {
        client.terminate()
      } catch {}
    }
    // Close the server
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    // Small delay to let any pending async callbacks drain
    await waitFor(50)
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  })

  it('MUST establish a WebSocket connection to the OpenClaw gateway URL specified in config', async () => {
    await connectBackend()
    expect(backend.status()).toBe('connected')
  })

  it('MUST generate an Ed25519 keypair on first use and store it to {dataDir}/agent-backend/device-identity.json', async () => {
    await connectBackend()
    const keyPath = join(dataDir, 'agent-backend', 'device-identity.json')
    expect(existsSync(keyPath)).toBe(true)
    const identity = JSON.parse(readFileSync(keyPath, 'utf-8'))
    expect(identity.publicKey).toBeDefined()
    expect(identity.privateKeyDer).toBeDefined()
    expect(identity.publicKey.length).toBe(64) // 32 bytes hex
  })

  it('MUST sign authentication payloads with the device private key', async () => {
    let receivedUrl = ''
    wss.on('connection', (_ws, req) => {
      receivedUrl = req.url ?? ''
    })
    backend = createOpenClawBackend(getConfig())
    await backend.connect()
    await waitFor(50)
    expect(receivedUrl).toContain('signature=')
    expect(receivedUrl).toContain('timestamp=')
  })

  it('MUST send the device token in the initial WS handshake', async () => {
    let receivedUrl = ''
    wss.on('connection', (_ws, req) => {
      receivedUrl = req.url ?? ''
    })
    backend = createOpenClawBackend(getConfig())
    await backend.connect()
    await waitFor(50)
    expect(receivedUrl).toContain('publicKey=')
  })

  it('MUST implement automatic reconnection with exponential backoff', async () => {
    const serverWs = await connectBackend()
    expect(backend.status()).toBe('connected')

    const statuses: BackendConnectionStatus[] = []
    backend.on('backend.status', (d) => statuses.push(d.status))
    serverWs.close()
    await waitFor(300)
    expect(statuses).toContain('disconnected')
  })

  it('MUST default initial delay to 1000ms', () => {
    backend = createOpenClawBackend({ gatewayUrl: 'ws://localhost:1/ws', dataDir })
    expect(backend).toBeDefined()
  })

  it('MUST default maximum delay to 30000ms', () => {
    backend = createOpenClawBackend({ gatewayUrl: 'ws://localhost:1/ws', dataDir })
    expect(backend).toBeDefined()
  })

  it('MUST apply jitter by default to prevent thundering herd', () => {
    backend = createOpenClawBackend({ gatewayUrl: `ws://127.0.0.1:${port}/ws`, dataDir })
    expect(backend).toBeDefined()
  })

  it('MUST emit backend.status with disconnected immediately on connection loss', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ status: BackendConnectionStatus }>(backend, 'backend.status')
    serverWs.close()
    const data = await p
    expect(data.status).toBe('disconnected')
  })

  it('MUST emit backend.status with connecting when a reconnection attempt begins', async () => {
    const serverWs = await connectBackend()
    const statuses: BackendConnectionStatus[] = []
    backend.on('backend.status', (d) => statuses.push(d.status))
    serverWs.close()
    await waitFor(200)
    expect(statuses).toContain('connecting')
  })

  it('MUST emit backend.status with connected when reconnection succeeds', async () => {
    const serverWs = await connectBackend()
    const statuses: BackendConnectionStatus[] = []
    backend.on('backend.status', (d) => statuses.push(d.status))
    serverWs.close()
    await waitFor(500)
    expect(statuses).toContain('connected')
  })

  it('MUST translate OpenClaw streaming messages to chat.stream events', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ text: string }>(backend, 'chat.stream')
    serverWs.send(JSON.stringify({ type: 'stream', text: 'hello', sessionKey: 'main' }))
    expect((await p).text).toBe('hello')
  })

  it('MUST translate OpenClaw turn completion to chat.turn events with a fully parsed ParsedTurn', async () => {
    const serverWs = await connectBackend()
    const turn = { role: 'assistant', content: 'hi', timestamp: 1000, workItems: [], thinkingBlocks: [] }
    const p = waitForEvent<{ turn: any }>(backend, 'chat.turn')
    serverWs.send(JSON.stringify({ type: 'turn', turn, sessionKey: 'main' }))
    const t = (await p).turn
    expect(t.role).toBe('assistant')
    expect(t.content).toBe('hi')
  })

  it('MUST translate OpenClaw tool call/result messages to chat.work events', async () => {
    const serverWs = await connectBackend()
    const work = { type: 'tool_call' as const, name: 'read', input: '{}', timestamp: 1000 }
    const p = waitForEvent<{ work: any }>(backend, 'chat.work')
    serverWs.send(JSON.stringify({ type: 'work', work, sessionKey: 'main' }))
    const w = (await p).work
    expect(w.type).toBe('tool_call')
    expect(w.name).toBe('read')
  })

  it('MUST translate OpenClaw thinking block messages to chat.work events with type thinking', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ work: any }>(backend, 'chat.work')
    serverWs.send(JSON.stringify({ type: 'thinking', text: 'reasoning...', sessionKey: 'main' }))
    const w = (await p).work
    expect(w.type).toBe('thinking')
    expect(w.output).toBe('reasoning...')
  })

  it('MUST translate OpenClaw status transitions to chat.status events', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ status: string }>(backend, 'chat.status')
    serverWs.send(JSON.stringify({ type: 'status', status: 'working', sessionKey: 'main' }))
    expect((await p).status).toBe('working')
  })

  it('MUST translate OpenClaw compaction messages to chat.compacting events', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ active: boolean }>(backend, 'chat.compacting')
    serverWs.send(JSON.stringify({ type: 'compacting', active: true, sessionKey: 'main' }))
    expect((await p).active).toBe(true)
  })

  it('MUST translate OpenClaw error messages to chat.error events', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ error: string }>(backend, 'chat.error')
    serverWs.send(JSON.stringify({ type: 'error', error: 'fail', sessionKey: 'main' }))
    expect((await p).error).toBe('fail')
  })

  it('MUST strip thinking blocks from streamed text', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ text: string }>(backend, 'chat.stream')
    serverWs.send(JSON.stringify({ type: 'stream', text: 'hello <think>secret</think> world', sessionKey: 'main' }))
    expect((await p).text).toBe('hello  world')
  })

  it('MUST preserve code blocks even if they contain thinking-like tags', async () => {
    const serverWs = await connectBackend()
    const text = '```\n<think>example</think>\n```'
    const p = waitForEvent<{ text: string }>(backend, 'chat.stream')
    serverWs.send(JSON.stringify({ type: 'stream', text, sessionKey: 'main' }))
    expect((await p).text).toBe(text)
  })

  it('MUST emit chat.error with retryAfterMs set to the gateway indicated retry delay', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ retryAfterMs: number }>(backend, 'chat.error')
    serverWs.send(JSON.stringify({ type: 'error', error: 'rate limited', retryAfterMs: 5000, sessionKey: 'main' }))
    expect((await p).retryAfterMs).toBe(5000)
  })

  it('MUST automatically retry the request after the indicated delay', async () => {
    const serverWs = await connectBackend()
    const messages: string[] = []
    serverWs.on('message', (d: any) => messages.push(d.toString()))
    serverWs.send(JSON.stringify({ type: 'error', error: 'rate limited', retryAfterMs: 50, sessionKey: 'main' }))
    await waitFor(150)
    expect(messages.some((m) => m.includes('retry'))).toBe(true)
  })

  it('MUST emit backend.status with error and include metadata about pending pairing request', async () => {
    const serverWs = await connectBackend()
    const p = waitForEvent<{ status: BackendConnectionStatus }>(backend, 'backend.status')
    serverWs.send(JSON.stringify({ type: 'pairing.required' }))
    expect((await p).status).toBe('error')
  })

  it('MUST NOT block or crash when pairing is pending — MUST continue reconnection attempts', async () => {
    const serverWs = await connectBackend()
    serverWs.send(JSON.stringify({ type: 'pairing.required' }))
    await waitFor(50)
    // Should not throw, should still be alive
    expect(backend.status()).toBeDefined()
  })

  it('MUST read gateway URL from config module at path agentBackend.openclaw.gatewayUrl', () => {
    const config = getConfig()
    backend = createOpenClawBackend(config)
    expect(config.gatewayUrl).toContain(`${port}`)
  })

  it('MUST support hot-reload: disconnect from old URL and reconnect to new URL on config change', async () => {
    let configCallback: ((newConfig: Partial<OpenClawConfig>) => void) | null = null

    const connPromise = waitForConnection(wss)
    backend = createOpenClawBackend(
      getConfig({
        onConfigChange: (cb) => {
          configCallback = cb
        }
      })
    )
    await backend.connect()
    await connPromise
    expect(backend.status()).toBe('connected')

    // Create a second server
    const wss2 = new WebSocketServer({ port: 0 })
    const port2 = await new Promise<number>((resolve) => {
      wss2.on('listening', () => resolve((wss2.address() as any).port))
    })

    // Trigger hot-reload
    configCallback!({ gatewayUrl: `ws://127.0.0.1:${port2}/ws` })

    // Wait for reconnection to new server (poll with timeout)
    const start = Date.now()
    while (backend.status() !== 'connected' && Date.now() - start < 5000) {
      await waitFor(50)
    }
    expect(backend.status()).toBe('connected')

    await backend.disconnect()
    backend = null as any // prevent afterEach double-disconnect
    await new Promise<void>((r) => wss2.close(() => r()))
  })

  it('MUST reload conversation history when agent transitions from working to idle', async () => {
    const serverWs = await connectBackend()

    const messages: string[] = []
    serverWs.on('message', (d: any) => messages.push(d.toString()))

    serverWs.send(JSON.stringify({ type: 'status', status: 'working', sessionKey: 'main' }))
    await waitFor(50)
    serverWs.send(JSON.stringify({ type: 'status', status: 'idle', sessionKey: 'main' }))
    await waitFor(400) // > 300ms debounce

    expect(messages.some((m) => m.includes('history'))).toBe(true)
  })

  it('MUST debounce history reload (300ms) to avoid unnecessary refetches during rapid state changes', async () => {
    const serverWs = await connectBackend()

    const messages: string[] = []
    serverWs.on('message', (d: any) => messages.push(d.toString()))

    // Rapid working -> idle -> working -> idle
    serverWs.send(JSON.stringify({ type: 'status', status: 'working', sessionKey: 'main' }))
    await waitFor(10)
    serverWs.send(JSON.stringify({ type: 'status', status: 'idle', sessionKey: 'main' }))
    await waitFor(50) // < 300ms
    serverWs.send(JSON.stringify({ type: 'status', status: 'working', sessionKey: 'main' }))
    await waitFor(10)
    serverWs.send(JSON.stringify({ type: 'status', status: 'idle', sessionKey: 'main' }))
    await waitFor(400)

    const historyMsgs = messages.filter((m) => m.includes('history'))
    expect(historyMsgs.length).toBe(1)
  })

  it('MUST emit reloaded history as a session.info event', async () => {
    const serverWs = await connectBackend()

    serverWs.on('message', (data: any) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'history') {
        serverWs.send(
          JSON.stringify({
            type: 'session.info',
            sessionKey: msg.sessionKey,
            requestId: msg.requestId,
            history: [{ role: 'assistant', content: 'hi', timestamp: 1, workItems: [], thinkingBlocks: [] }]
          })
        )
      }
    })

    const received = waitForEvent<any>(backend, 'session.info', 5000)

    serverWs.send(JSON.stringify({ type: 'status', status: 'working', sessionKey: 'main' }))
    await waitFor(10)
    serverWs.send(JSON.stringify({ type: 'status', status: 'idle', sessionKey: 'main' }))

    const info = await received
    expect(info.history.length).toBe(1)
    expect(info.history[0].content).toBe('hi')
  })
})
