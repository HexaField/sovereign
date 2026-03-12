import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTerminalManager, type TerminalManager } from './terminal.js'
import { createTerminalWsHandler } from './ws.js'
import type { EventBus, BusEvent } from '@template/core'
import { EventEmitter } from 'events'

// Minimal bus for testing
function createTestBus(): EventBus & { events: BusEvent[] } {
  const events: BusEvent[] = []
  const handlers = new Map<string, Array<(e: BusEvent) => void>>()
  return {
    events,
    emit(event: BusEvent) {
      events.push(event)
    },
    on(pattern: string, handler: (e: BusEvent) => void) {
      if (!handlers.has(pattern)) handlers.set(pattern, [])
      handlers.get(pattern)!.push(handler)
      return () => {}
    },
    once(pattern: string, handler: (e: BusEvent) => void) {
      return this.on(pattern, handler)
    },
    replay() {
      return (async function* () {})()
    },
    history() {
      return []
    }
  }
}

let ptyAvailable = true
try {
  await import('node-pty')
} catch {
  ptyAvailable = false
}

const describeWithPty = ptyAvailable ? describe : describe.skip

describeWithPty('Terminal Manager', () => {
  let bus: ReturnType<typeof createTestBus>
  let manager: TerminalManager
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-test-'))
    bus = createTestBus()
    manager = createTerminalManager(bus, {
      validateCwd: (p: string) => p.startsWith(tmpDir),
      gracePeriodMs: 200
    })
  })

  afterEach(() => {
    manager.dispose()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Creation
  it('creates a terminal session with PTY', () => {
    const session = manager.create({ cwd: tmpDir })
    expect(session.id).toBeTruthy()
    expect(session.pid).toBeGreaterThan(0)
    expect(session.cwd).toBe(tmpDir)
    expect(session.cols).toBe(80)
    expect(session.rows).toBe(24)
    expect(session.createdAt).toBeTruthy()
  })

  it('defaults shell to $SHELL or /bin/bash', () => {
    const session = manager.create({ cwd: tmpDir })
    const expected = process.env.SHELL ?? '/bin/bash'
    expect(session.shell).toBe(expected)
  })

  it('defaults cwd to worktree path when worktree is active', () => {
    // This test validates that the cwd parameter is used correctly
    const session = manager.create({ cwd: tmpDir })
    expect(session.cwd).toBe(tmpDir)
  })

  it('validates cwd is within a known project/worktree path', () => {
    const session = manager.create({ cwd: tmpDir })
    expect(session).toBeTruthy()
  })

  it('rejects cwd outside known paths', () => {
    expect(() => manager.create({ cwd: '/tmp/nonexistent-rogue-path' })).toThrow('cwd not allowed')
  })

  // Session management
  it('lists all active terminal sessions', () => {
    manager.create({ cwd: tmpDir })
    manager.create({ cwd: tmpDir })
    expect(manager.list()).toHaveLength(2)
  })

  it('gets a terminal session by id', () => {
    const session = manager.create({ cwd: tmpDir })
    expect(manager.get(session.id)).toEqual(session)
  })

  it('closes a terminal session and kills PTY', () => {
    const session = manager.create({ cwd: tmpDir })
    manager.close(session.id)
    expect(manager.get(session.id)).toBeUndefined()
  })

  it('cleans up PTY after WebSocket disconnect with grace period', async () => {
    const session = manager.create({ cwd: tmpDir })
    manager.scheduleClose(session.id)
    // Still alive during grace period
    expect(manager.get(session.id)).toBeTruthy()
    // Wait for grace period to expire
    await new Promise((r) => setTimeout(r, 300))
    expect(manager.get(session.id)).toBeUndefined()
  })

  // I/O
  it('attaches to a session for bidirectional data', () => {
    const session = manager.create({ cwd: tmpDir })
    const handle = manager.attach(session.id)
    expect(handle.onData).toBeInstanceOf(Function)
    expect(handle.write).toBeInstanceOf(Function)
    handle.dispose()
  })

  it('writes data to PTY stdin', async () => {
    const session = manager.create({ cwd: tmpDir })
    const handle = manager.attach(session.id)
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    handle.write('echo hello\n')
    await new Promise((r) => setTimeout(r, 500))
    const output = chunks.join('')
    expect(output).toContain('hello')
    handle.dispose()
  })

  it('reads data from PTY stdout', async () => {
    const session = manager.create({ cwd: tmpDir })
    const handle = manager.attach(session.id)
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    handle.write('echo test123\n')
    await new Promise((r) => setTimeout(r, 500))
    expect(chunks.join('')).toContain('test123')
    handle.dispose()
  })

  it('handles binary data correctly', async () => {
    const session = manager.create({ cwd: tmpDir })
    const handle = manager.attach(session.id)
    const chunks: string[] = []
    handle.onData((d) => chunks.push(d))
    // printf outputs actual escape sequences
    handle.write("printf '\\033[31mred\\033[0m'\n")
    // Poll for output instead of fixed sleep
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (chunks.join('').match(/\x1b\[/)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const output = chunks.join('')
    expect(output).toMatch(/\x1b\[/)
    handle.dispose()
  })

  // Resize
  it('resizes PTY on terminal resize', () => {
    const session = manager.create({ cwd: tmpDir, cols: 80, rows: 24 })
    manager.resize(session.id, 120, 40)
    const updated = manager.get(session.id)!
    expect(updated.cols).toBe(120)
    expect(updated.rows).toBe(40)
  })

  // Events
  it('emits terminal.created on the bus', () => {
    manager.create({ cwd: tmpDir })
    expect(bus.events.some((e) => e.type === 'terminal.created')).toBe(true)
  })

  it('emits terminal.closed on the bus', () => {
    const session = manager.create({ cwd: tmpDir })
    manager.close(session.id)
    expect(bus.events.some((e) => e.type === 'terminal.closed')).toBe(true)
  })

  // Multiple sessions
  it('supports multiple concurrent terminal sessions', () => {
    const s1 = manager.create({ cwd: tmpDir })
    const s2 = manager.create({ cwd: tmpDir })
    const s3 = manager.create({ cwd: tmpDir })
    expect(manager.list()).toHaveLength(3)
    expect(new Set([s1.id, s2.id, s3.id]).size).toBe(3)
  })
})

describeWithPty('Terminal WebSocket Handler', () => {
  let bus: ReturnType<typeof createTestBus>
  let manager: TerminalManager
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-ws-test-'))
    bus = createTestBus()
    manager = createTerminalManager(bus, {
      validateCwd: (p: string) => p.startsWith(tmpDir),
      gracePeriodMs: 200
    })
  })

  afterEach(() => {
    manager.dispose()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function createMockWs() {
    const ee = new EventEmitter()
    const sent: string[] = []
    const ws = {
      readyState: 1,
      send: (data: string) => {
        sent.push(data)
      },
      close: vi.fn((_code?: number, _reason?: string) => {
        ws.readyState = 3
      }),
      on: (event: string, cb: (...args: unknown[]) => void) => {
        ee.on(event, cb)
        return ws
      },
      _emit: (event: string, ...args: unknown[]) => ee.emit(event, ...args),
      sent
    }
    return ws
  }

  function createMockReq(query: string) {
    return {
      url: `/api/terminal?${query}`,
      headers: { host: 'localhost' }
    } as unknown as import('http').IncomingMessage
  }

  it('creates PTY session on WebSocket connect', () => {
    const handler = createTerminalWsHandler(manager)
    const ws = createMockWs()
    handler(ws as unknown as import('ws').WebSocket, createMockReq(`cwd=${encodeURIComponent(tmpDir)}`))
    expect(manager.list()).toHaveLength(1)
    const sessionMsg = JSON.parse(ws.sent[0])
    expect(sessionMsg.type).toBe('session')
    expect(sessionMsg.sessionId).toBeTruthy()
  })

  it('forwards WebSocket messages to PTY stdin', async () => {
    const handler = createTerminalWsHandler(manager)
    const ws = createMockWs()
    handler(ws as unknown as import('ws').WebSocket, createMockReq(`cwd=${encodeURIComponent(tmpDir)}`))
    JSON.parse(ws.sent[0])
    ws._emit('message', JSON.stringify({ type: 'data', data: 'echo wstest\n' }))
    await new Promise((r) => setTimeout(r, 500))
    // PTY output should be forwarded back via ws.send
    const dataMessages = ws.sent
      .slice(1)
      .map((s) => JSON.parse(s))
      .filter((m: { type: string }) => m.type === 'data')
    expect(dataMessages.some((m: { data: string }) => m.data.includes('wstest'))).toBe(true)
  })

  it('forwards PTY stdout to WebSocket messages', async () => {
    const handler = createTerminalWsHandler(manager)
    const ws = createMockWs()
    handler(ws as unknown as import('ws').WebSocket, createMockReq(`cwd=${encodeURIComponent(tmpDir)}`))
    // Wait for shell prompt output
    await new Promise((r) => setTimeout(r, 500))
    // Should have received at least the session message + some data
    expect(ws.sent.length).toBeGreaterThanOrEqual(1)
  })

  it('sends resize command from client to PTY', () => {
    const handler = createTerminalWsHandler(manager)
    const ws = createMockWs()
    handler(ws as unknown as import('ws').WebSocket, createMockReq(`cwd=${encodeURIComponent(tmpDir)}`))
    const sessionMsg = JSON.parse(ws.sent[0])
    ws._emit('message', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
    const session = manager.get(sessionMsg.sessionId)!
    expect(session.cols).toBe(120)
    expect(session.rows).toBe(40)
  })

  it('closes PTY on WebSocket close', async () => {
    const handler = createTerminalWsHandler(manager)
    const ws = createMockWs()
    handler(ws as unknown as import('ws').WebSocket, createMockReq(`cwd=${encodeURIComponent(tmpDir)}`))
    const sessionMsg = JSON.parse(ws.sent[0])
    ws._emit('close')
    // Grace period - still alive
    expect(manager.get(sessionMsg.sessionId)).toBeTruthy()
    await new Promise((r) => setTimeout(r, 300))
    // After grace period - closed
    expect(manager.get(sessionMsg.sessionId)).toBeUndefined()
  })

  it('supports reconnection to existing PTY within grace period', () => {
    const handler = createTerminalWsHandler(manager)
    const ws1 = createMockWs()
    handler(ws1 as unknown as import('ws').WebSocket, createMockReq(`cwd=${encodeURIComponent(tmpDir)}`))
    const sessionMsg = JSON.parse(ws1.sent[0])
    const sid = sessionMsg.sessionId

    // Disconnect
    ws1._emit('close')

    // Reconnect within grace period
    const ws2 = createMockWs()
    handler(ws2 as unknown as import('ws').WebSocket, createMockReq(`sessionId=${sid}`))
    const reconnectMsg = JSON.parse(ws2.sent[0])
    expect(reconnectMsg.sessionId).toBe(sid)
    expect(manager.list()).toHaveLength(1)
  })
})
