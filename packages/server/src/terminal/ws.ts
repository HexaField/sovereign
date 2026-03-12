import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'
import type { EventBus } from '@template/core'
import type { WsHandler } from '../ws/handler.js'
import type { TerminalManager, AttachHandle } from './terminal.js'

export interface WsMessage {
  type: 'data' | 'resize' | 'close'
  data?: string
  cols?: number
  rows?: number
  sessionId?: string
}

// Legacy WS handler for direct WebSocket connections
export function createTerminalWsHandler(manager: TerminalManager) {
  return function handleConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const sessionId = url.searchParams.get('sessionId')

    let sid: string

    if (sessionId && manager.get(sessionId)) {
      // Reconnect to existing session
      sid = sessionId
      manager.cancelScheduledClose(sid)
    } else {
      // Create new session
      const cwd = url.searchParams.get('cwd') ?? process.cwd()
      const shell = url.searchParams.get('shell') ?? undefined
      const cols = parseInt(url.searchParams.get('cols') ?? '80', 10)
      const rows = parseInt(url.searchParams.get('rows') ?? '24', 10)
      try {
        const session = manager.create({ cwd, shell, cols, rows })
        sid = session.id
      } catch (err: unknown) {
        ws.close(1008, err instanceof Error ? err.message : 'Failed to create session')
        return
      }
    }

    // Send session id to client
    ws.send(JSON.stringify({ type: 'session', sessionId: sid }))

    const handle = manager.attach(sid)

    handle.onData((data: string) => {
      if (ws.readyState === 1) {
        // OPEN
        ws.send(JSON.stringify({ type: 'data', data }))
      }
    })

    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg: WsMessage = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
        switch (msg.type) {
          case 'data':
            if (msg.data) handle.write(msg.data)
            break
          case 'resize':
            if (msg.cols && msg.rows) manager.resize(sid, msg.cols, msg.rows)
            break
          case 'close':
            manager.close(sid)
            ws.close()
            break
        }
      } catch {
        // ignore malformed messages
      }
    })

    ws.on('close', () => {
      handle.dispose()
      // Schedule cleanup with grace period for reconnection
      if (manager.get(sid)) {
        manager.scheduleClose(sid)
      }
    })
  }
}

// Channel-based WS handler for the unified WS system
// Track per-device attach handles keyed by deviceId
const attachments = new Map<string, { sessionId: string; handle: AttachHandle }>()

export function registerTerminalChannel(ws: WsHandler, bus: EventBus, manager: TerminalManager): void {
  ws.registerChannel('terminal', {
    serverMessages: ['terminal.data', 'terminal.created', 'terminal.closed'],
    clientMessages: ['terminal.input', 'terminal.resize'],
    binary: true,

    onSubscribe(deviceId: string, scope?: Record<string, string>) {
      const sessionId = scope?.sessionId
      if (!sessionId) return
      if (!manager.get(sessionId)) return

      // Cancel any pending grace-period close
      manager.cancelScheduledClose(sessionId)

      const handle = manager.attach(sessionId)
      handle.onData((data: string) => {
        ws.sendBinary('terminal', Buffer.from(data), { sessionId })
      })
      attachments.set(deviceId, { sessionId, handle })
    },

    onMessage(type: string, payload: unknown, deviceId: string) {
      const attachment = attachments.get(deviceId)
      if (!attachment) return

      if (type === 'terminal.input') {
        const msg = payload as { data?: string }
        if (msg.data) attachment.handle.write(msg.data)
      } else if (type === 'terminal.resize') {
        const msg = payload as { cols?: number; rows?: number }
        if (msg.cols && msg.rows) {
          manager.resize(attachment.sessionId, msg.cols, msg.rows)
        }
      }
    },

    onUnsubscribe(deviceId: string) {
      const attachment = attachments.get(deviceId)
      if (!attachment) return
      attachment.handle.dispose()
      attachments.delete(deviceId)
    },

    onDisconnect(deviceId: string) {
      const attachment = attachments.get(deviceId)
      if (!attachment) return
      attachment.handle.dispose()
      // Schedule grace-period close
      manager.scheduleClose(attachment.sessionId)
      attachments.delete(deviceId)
    }
  })

  // Bridge bus events for created/closed
  bus.on('terminal.created', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel('terminal', {
      type: 'terminal.created',
      ...p,
      timestamp: new Date().toISOString()
    })
  })

  bus.on('terminal.closed', (event) => {
    const p = event.payload as Record<string, string>
    ws.broadcastToChannel('terminal', {
      type: 'terminal.closed',
      ...p,
      timestamp: new Date().toISOString()
    })
  })
}
