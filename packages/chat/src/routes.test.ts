import { describe, it, expect, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import express from 'express'
import { createChatRoutes } from './routes.js'

describe('GET /api/threads/:threadId/history — response cache', () => {
  let server: Server | undefined

  afterEach(() => {
    server?.close()
  })

  it('a new turn invalidates the cached history with no SSE stream open', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-chat-routes-'))
    const chatEvents = new EventEmitter()
    let turns = [{ role: 'user', content: 'one' }]
    const chatModule = { chatEvents, resolveSessionKey: (id: string) => id } as any
    const backend = { getHistory: async () => ({ turns, hasMore: false }) } as any

    const app = express()
    app.use(createChatRoutes(chatModule, backend, dataDir))
    server = app.listen(0)
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/threads/t1/history`
    const read = async () => ((await (await fetch(url)).json()) as { turns: unknown[] }).turns

    expect(await read()).toHaveLength(1)
    turns = [...turns, { role: 'assistant', content: 'two' }]
    chatEvents.emit('chat.turn', { threadId: 't1', turn: turns[1] })
    // Inside the cache window: the new turn must show.
    expect(await read()).toHaveLength(2)
  })
})
