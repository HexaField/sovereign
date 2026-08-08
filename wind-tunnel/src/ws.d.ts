// Local type declaration for ws — the wind tunnel's own node_modules
// uses npm while the parent monorepo uses pnpm, so @types/ws doesn't
// resolve through the standard typeRoots path.
declare module 'ws' {
  import { EventEmitter } from 'node:events'
  import type { IncomingMessage } from 'node:http'

  type RawData = Buffer | ArrayBuffer | Buffer[]

  class WebSocket extends EventEmitter {
    static readonly OPEN: number
    static readonly CLOSED: number
    static readonly CONNECTING: number
    static readonly CLOSING: number

    readonly readyState: number

    constructor(url: string, opts?: Record<string, unknown>)
    send(data: string | Buffer | ArrayBuffer, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void

    on(event: 'open', listener: () => void): this
    on(event: 'close', listener: (code: number, reason: Buffer) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): this
    on(event: string, listener: (...args: any[]) => void): this
  }

  export default WebSocket
  export { WebSocket, RawData }
}
