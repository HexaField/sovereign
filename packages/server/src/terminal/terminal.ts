import type { EventBus } from '@sovereign/core'
import type { TerminalSession } from './types.js'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'

export interface TerminalManagerOptions {
  validateCwd: (path: string) => boolean
  gracePeriodMs?: number
}

export interface AttachHandle {
  onData: (cb: (data: string) => void) => void
  write: (data: string) => void
  dispose: () => void
}

export interface TerminalManager {
  create(opts: { cwd: string; shell?: string; cols?: number; rows?: number }): TerminalSession
  attach(sessionId: string): AttachHandle
  resize(sessionId: string, cols: number, rows: number): void
  close(sessionId: string): void
  list(): TerminalSession[]
  get(sessionId: string): TerminalSession | undefined
  scheduleClose(sessionId: string): void
  cancelScheduledClose(sessionId: string): void
  dispose(): void
}

type PtyModule = typeof import('node-pty')

const require = createRequire(import.meta.url)
let ptyModule: PtyModule | null = null

function getPty(): PtyModule {
  if (!ptyModule) {
    ptyModule = require('node-pty') as PtyModule
  }
  return ptyModule
}

interface InternalSession {
  meta: TerminalSession
  pty: import('node-pty').IPty
  gracePeriodTimer?: ReturnType<typeof setTimeout>
}

export function createTerminalManager(bus: EventBus, opts: TerminalManagerOptions): TerminalManager {
  const sessions = new Map<string, InternalSession>()
  const gracePeriodMs = opts.gracePeriodMs ?? 5000

  return {
    create({ cwd, shell, cols = 80, rows = 24 }) {
      if (!opts.validateCwd(cwd)) {
        throw new Error(`cwd not allowed: ${cwd}`)
      }
      const resolvedShell = shell ?? process.env.SHELL ?? '/bin/bash'
      const id = randomUUID()
      const proc = getPty().spawn(resolvedShell, [], { name: 'xterm-256color', cols, rows, cwd })
      const meta: TerminalSession = {
        id,
        pid: proc.pid,
        cwd,
        shell: resolvedShell,
        cols,
        rows,
        createdAt: new Date().toISOString()
      }
      sessions.set(id, { meta, pty: proc })
      bus.emit({ type: 'terminal.created', timestamp: meta.createdAt, source: 'terminal', payload: meta })
      return meta
    },

    attach(sessionId: string): AttachHandle {
      const s = sessions.get(sessionId)
      if (!s) throw new Error(`session not found: ${sessionId}`)
      let disposable: import('node-pty').IDisposable | undefined
      return {
        onData(cb: (data: string) => void) {
          disposable = s.pty.onData(cb)
        },
        write(data: string) {
          s.pty.write(data)
        },
        dispose() {
          disposable?.dispose()
        }
      }
    },

    resize(sessionId: string, cols: number, rows: number) {
      const s = sessions.get(sessionId)
      if (!s) throw new Error(`session not found: ${sessionId}`)
      s.pty.resize(cols, rows)
      s.meta.cols = cols
      s.meta.rows = rows
    },

    close(sessionId: string) {
      const s = sessions.get(sessionId)
      if (!s) return
      if (s.gracePeriodTimer) clearTimeout(s.gracePeriodTimer)
      s.pty.kill()
      sessions.delete(sessionId)
      bus.emit({
        type: 'terminal.closed',
        timestamp: new Date().toISOString(),
        source: 'terminal',
        payload: { id: sessionId }
      })
    },

    list() {
      return Array.from(sessions.values()).map((s) => s.meta)
    },

    get(sessionId: string) {
      return sessions.get(sessionId)?.meta
    },

    scheduleClose(sessionId: string) {
      const s = sessions.get(sessionId)
      if (!s) return
      s.gracePeriodTimer = setTimeout(() => {
        this.close(sessionId)
      }, gracePeriodMs)
    },

    cancelScheduledClose(sessionId: string) {
      const s = sessions.get(sessionId)
      if (!s) return
      if (s.gracePeriodTimer) {
        clearTimeout(s.gracePeriodTimer)
        s.gracePeriodTimer = undefined
      }
    },

    dispose() {
      for (const [id] of sessions) {
        this.close(id)
      }
    }
  }
}
