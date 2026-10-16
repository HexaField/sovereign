import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus, type BusEvent } from '@sovereign/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryTaskPort } from './memory-task-port.js'
import { registerForgeChannel } from './ws.js'

describe('memory TaskPort', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-port-'))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('ensureTask is idempotent per key; streams nest; links refuse cycles', async () => {
    const port = createMemoryTaskPort()
    const a = await port.ensureTask('k1', { name: 'A', membrane: 'acme', kind: 'change' })
    expect(await port.ensureTask('k1', { name: 'other', membrane: 'acme', kind: 'change' })).toBe(a)
    const s = await port.createStream('acme', 'Plan 20')
    const sub = await port.createStream('acme', 'Part 1', s.id)
    expect(sub.parentId).toBe(s.id)
    await port.addToStream(sub.id, a.id)
    await expect(port.addToStream(a.id, s.id)).rejects.toThrow(/work stream/)
    await expect(port.addToStream(sub.id, s.id)).rejects.toThrow(/cycle/)
    await expect(port.createStream('acme', 'x', a.id)).rejects.toThrow(/work stream/)
    expect((await port.streamsOf('acme')).map((x) => [x.name, x.memberCount])).toEqual([
      ['Plan 20', 1],
      ['Part 1', 1]
    ])
    await port.removeFromStream(sub.id, a.id)
    expect((await port.get(a.id))!.parentIds).toEqual([])
    expect(await port.streamsOf('other')).toEqual([])
  })

  it('persists tasks, views and related edges to its snapshot', async () => {
    const file = path.join(tmp, 'tasks.json')
    const port = createMemoryTaskPort({ file })
    const t = await port.ensureTask('k', { name: 'A', membrane: 'acme', kind: 'issue' })
    await port.setThread(t.id, 'th')
    await port.putViews('acme', [{ id: 'v', membrane: 'acme', title: 'V', repos: [], filters: {} }])
    await port.addRelated('acme', { from: 'a', to: 'b', kind: 'related', source: 'rethink', reason: 'r' })
    expect(await port.acceptRelated('acme', 'a', 'b', 'related')).toBe(true)
    expect(await port.acceptRelated('acme', 'a', 'x', 'related')).toBe(false)
    const again = createMemoryTaskPort({ file })
    expect((await again.findByKey('k'))!.threadId).toBe('th')
    expect(await again.getViews('acme')).toHaveLength(1)
    expect(await again.listRelated('acme')).toEqual([
      expect.objectContaining({ from: 'a', to: 'b', accepted: true, reason: 'r' })
    ])
    expect(await again.deleteRelated('acme', 'a', 'b', 'related')).toBe(true)
    expect(await again.deleteRelated('acme', 'a', 'b', 'related')).toBe(false)
  })

  it('emits the task.* events TaskService emits', async () => {
    const bus = createEventBus(path.join(tmp, 'bus'))
    const seen: BusEvent[] = []
    bus.on('task.*', (e) => {
      seen.push(e)
    })
    const port = createMemoryTaskPort({ bus })
    const t = await port.ensureTask('k', { name: 'A', membrane: 'acme', kind: 'change' })
    await port.setState(t.id, 'in_progress')
    await port.setState(t.id, 'in_progress')
    await new Promise((r) => setTimeout(r, 10))
    expect(seen.map((e) => e.type)).toEqual(['task.created', 'task.state_changed'])
    expect(seen[1].payload).toMatchObject({
      taskId: t.id,
      oldState: 'pending',
      newState: 'in_progress',
      sourceThreadId: 'forge'
    })
  })
})

describe('forge WS channel', () => {
  it('broadcasts forge.updated and forge.overlay on the forge channel', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-ws-'))
    try {
      const bus = createEventBus(tmp)
      const sent: Array<{ channel: string; msg: Record<string, unknown> }> = []
      const channels: string[] = []
      const off = registerForgeChannel(
        {
          registerChannel: (name) => void channels.push(name),
          broadcastToChannel: (channel, msg) => void sent.push({ channel, msg: msg as Record<string, unknown> })
        },
        bus
      )
      bus.emit({ type: 'forge.updated', timestamp: 't1', source: 'forge', payload: { membrane: 'acme' } })
      bus.emit({ type: 'forge.overlay', timestamp: 't2', source: 'forge', payload: { membrane: 'acme', overlays: [] } })
      bus.emit({ type: 'forge.other', timestamp: 't3', source: 'forge', payload: {} })
      await new Promise((r) => setTimeout(r, 10))
      expect(channels).toEqual(['forge'])
      expect(sent).toEqual([
        { channel: 'forge', msg: { type: 'forge.updated', membrane: 'acme', timestamp: 't1' } },
        { channel: 'forge', msg: { type: 'forge.overlay', membrane: 'acme', overlays: [], timestamp: 't2' } }
      ])
      off()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
