import type { IncomingMessage } from 'http'
import type { WebSocket } from 'ws'
import type { TerminalManager } from './terminal.js'

export interface WsMessage {
  type: 'data' | 'resize' | 'close'
  data?: string
  cols?: number
  rows?: number
  sessionId?: string
}

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
