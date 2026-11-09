import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { createThreadManager } from './threads.js'
import { createThreadRoutes } from './routes.js'
import { registerThreadsWs } from './ws.js'
import type { ThreadManager } from './types.js'

const forwardHandler = { forward: () => ({ success: true }) }

describe('Thread folders (/api/thread-folders, PUT /api/threads/:key/folder)', () => {
  let dataDir: string
  let bus: ReturnType<typeof createEventBus>
  let tm: ThreadManager
  let app: ReturnType<typeof express>

  function mount(manager: ThreadManager) {
    const a = express()
    a.use(express.json())
    a.use(createThreadRoutes(manager, forwardHandler as any, {}))
    return a
  }

  function events(type: string): Array<Record<string, any>> {
    const seen: Array<Record<string, any>> = []
    bus.on(type, (e) => {
      seen.push(e.payload as Record<string, any>)
    })
    return seen
  }

  const newFolder = async (name: string) => (await request(app).post('/api/thread-folders').send({ name })).body.folder

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sovereign-folders-'))
    bus = createEventBus(dataDir)
    tm = createThreadManager(bus, dataDir)
    app = mount(tm)
  })

  it('creates, lists and renames a folder, trimming the name', async () => {
    const res = await request(app).post('/api/thread-folders').send({ name: '  Dogs  ' })
    expect(res.status).toBe(201)
    expect(res.body.folder).toMatchObject({ name: 'Dogs' })
    expect(typeof res.body.folder.id).toBe('string')

    const list = await request(app).get('/api/thread-folders')
    expect(list.body.folders.map((f: { name: string }) => f.name)).toEqual(['Dogs'])

    const renamed = await request(app).patch(`/api/thread-folders/${res.body.folder.id}`).send({ name: 'Dog care' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.folder.name).toBe('Dog care')
  })

  it('refuses an empty, too long or already used name', async () => {
    for (const name of [undefined, '', '   ', 7, 'x'.repeat(81)]) {
      const res = await request(app).post('/api/thread-folders').send({ name })
      expect(res.status).toBe(400)
    }
    const dogs = await newFolder('Dogs')
    expect((await request(app).post('/api/thread-folders').send({ name: 'dogs' })).status).toBe(409)
    const cats = await newFolder('Cats')
    expect((await request(app).patch(`/api/thread-folders/${cats.id}`).send({ name: 'DOGS' })).status).toBe(409)
    // Renaming a folder to its own name (another case) is fine.
    expect((await request(app).patch(`/api/thread-folders/${dogs.id}`).send({ name: 'DOGS' })).status).toBe(200)
  })

  it('404s an unknown folder', async () => {
    expect((await request(app).patch('/api/thread-folders/nope').send({ name: 'X' })).status).toBe(404)
    expect((await request(app).delete('/api/thread-folders/nope')).status).toBe(404)
    const t = tm.create({ label: 'a' })
    expect((await request(app).put(`/api/threads/${t.id}/folder`).send({ folderId: 'nope' })).status).toBe(404)
    expect((await request(app).put('/api/threads/nope/folder').send({ folderId: null })).status).toBe(404)
  })

  it('moves a thread into a folder and out again, at the top of its new list, without touching activity', async () => {
    const dogs = await newFolder('Dogs')
    const t = tm.create({ label: 'grooming' })
    t.lastActivity = 1_000
    t.sortOrder = 4
    const into = await request(app).put(`/api/threads/${t.id}/folder`).send({ folderId: dogs.id })
    expect(into.status).toBe(200)
    expect(into.body.thread.folderId).toBe(dogs.id)
    expect(tm.get(t.id)?.sortOrder).toBeUndefined()
    expect(tm.get(t.id)?.lastActivity).toBe(1_000)

    const out = await request(app).put(`/api/threads/${t.id}/folder`).send({ folderId: null })
    expect(out.status).toBe(200)
    expect(tm.get(t.id)?.folderId).toBeUndefined()
  })

  it('validates folderId', async () => {
    const t = tm.create({ label: 'a' })
    for (const folderId of [undefined, '', 3, {}]) {
      expect((await request(app).put(`/api/threads/${t.id}/folder`).send({ folderId })).status).toBe(400)
    }
  })

  it('keeps a pin when filing a thread', async () => {
    const dogs = await newFolder('Dogs')
    const t = tm.create({ label: 'a' })
    tm.update(t.id, { pinned: true })
    await request(app).put(`/api/threads/${t.id}/folder`).send({ folderId: dogs.id })
    expect(tm.get(t.id)?.pinnedAt).toBeGreaterThan(0)
  })

  it('deleting a folder keeps its threads, back in the main list', async () => {
    const dogs = await newFolder('Dogs')
    const [a, b] = ['breeding', 'training'].map((label) => tm.create({ label }))
    for (const t of [a, b]) tm.moveToFolder!(t.id, dogs.id)
    const updates = events('thread.updated')
    const res = await request(app).delete(`/api/thread-folders/${dogs.id}`)
    expect(res.status).toBe(200)
    for (const t of [a, b]) {
      expect(tm.get(t.id)?.archived).toBe(false)
      expect(tm.get(t.id)?.folderId).toBeUndefined()
    }
    expect(updates.map((u) => u.patch)).toEqual([
      { folderId: null, sortOrder: null },
      { folderId: null, sortOrder: null }
    ])
    expect((await request(app).get('/api/thread-folders')).body.folders).toEqual([])
  })

  it('reorders within a folder, and refuses a reorder mixing lists', async () => {
    const dogs = await newFolder('Dogs')
    const [a, b, c] = ['a', 'b', 'c'].map((label) => tm.create({ label }))
    tm.moveToFolder!(a.id, dogs.id)
    tm.moveToFolder!(b.id, dogs.id)
    const ok = await request(app)
      .post('/api/threads/reorder')
      .send({ ids: [b.id, a.id] })
    expect(ok.status).toBe(200)
    expect(tm.get(b.id)!.sortOrder!).toBeLessThan(tm.get(a.id)!.sortOrder!)
    const mixed = await request(app)
      .post('/api/threads/reorder')
      .send({ ids: [a.id, c.id] })
    expect(mixed.status).toBe(400)
    expect(tm.get(c.id)?.sortOrder).toBeUndefined()
  })

  it('survives a restart: folders, membership and order', async () => {
    const dogs = await newFolder('Dogs')
    const [a, b] = ['a', 'b'].map((label) => tm.create({ label }))
    tm.moveToFolder!(a.id, dogs.id)
    tm.moveToFolder!(b.id, dogs.id)
    tm.reorder!([b.id, a.id])
    const again = createThreadManager(createEventBus(dataDir), dataDir)
    expect(again.listFolders!()).toEqual([dogs])
    expect(again.get(a.id)?.folderId).toBe(dogs.id)
    expect(again.get(b.id)!.sortOrder!).toBeLessThan(again.get(a.id)!.sortOrder!)
  })

  it('a thread whose folder file is gone loads into the main list', async () => {
    const dogs = await newFolder('Dogs')
    const t = tm.create({ label: 'a' })
    tm.moveToFolder!(t.id, dogs.id)
    fs.rmSync(path.join(dataDir, 'thread-folders.json'))
    const again = createThreadManager(createEventBus(dataDir), dataDir)
    expect(again.get(t.id)?.folderId).toBeUndefined()
  })

  it('broadcasts the folder list on thread.folders, over the threads WS channel', async () => {
    const sent: Array<{ type: string; payload: any }> = []
    registerThreadsWs({ registerChannel: () => {}, broadcastToChannel: (_c, msg) => sent.push(msg) }, tm, bus)
    const dogs = await newFolder('Dogs')
    await request(app).patch(`/api/thread-folders/${dogs.id}`).send({ name: 'Dog care' })
    await request(app).delete(`/api/thread-folders/${dogs.id}`)
    const lists = sent.filter((m) => m.type === 'thread.folders').map((m) => m.payload.folders.map((f: any) => f.name))
    expect(lists).toEqual([['Dogs'], ['Dog care'], []])
  })

  it('a rename to the same name broadcasts nothing; filing a thread where it already is neither', async () => {
    const dogs = await newFolder('Dogs')
    const t = tm.create({ label: 'a' })
    tm.moveToFolder!(t.id, dogs.id)
    const folderEvents = events('thread.folders')
    const updates = events('thread.updated')
    await request(app).patch(`/api/thread-folders/${dogs.id}`).send({ name: 'Dogs' })
    await request(app).put(`/api/threads/${t.id}/folder`).send({ folderId: dogs.id })
    expect(folderEvents).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  it('answers 501 when the manager has no folders', async () => {
    const bare = mount({ ...tm, listFolders: undefined, createFolder: undefined } as ThreadManager)
    expect((await request(bare).get('/api/thread-folders')).status).toBe(501)
    expect((await request(bare).post('/api/thread-folders').send({ name: 'X' })).status).toBe(501)
  })
})
