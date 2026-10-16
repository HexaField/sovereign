import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEventBus } from '@sovereign/core'
import { describe, expect, it } from 'vitest'
import { registerForgeChannel } from './ws.js'

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
