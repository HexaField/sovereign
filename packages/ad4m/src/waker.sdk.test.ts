// The waker on the SDK's WakerSubscriptionManager: the subscription it opens
// per neighbourhood, and what a mention puts on the bus. A fake
// QuerySubscriptionProxy stands in for the executor's live query.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import { mentionSubscription, startWaker } from './waker.js'

const DID = 'did:key:z6MkHex'

describe('mentionSubscription', () => {
  it('is a model query over TextContent: every term, never the agent’s own links', () => {
    const sub = mentionSubscription('p-1', { did: DID, names: ['Hex'] })
    expect(sub).toMatchObject({
      id: 'mention-p-1',
      type: 'mention',
      perspective: 'p-1',
      className: 'ad4m://TextContent',
      terms: ['Hex', DID]
    })
    expect(JSON.parse(sub.query)).toEqual({
      where: {
        OR: [{ text: { contains: 'Hex', author: { not: DID } } }, { text: { contains: DID, author: { not: DID } } }]
      },
      order: { timestamp: 'DESC' },
      limit: 50,
      properties: ['text']
    })
  })
})

// ── Fakes ──────────────────────────────────────────────────────────────────────

const proxies: FakeProxy[] = []
/** What a proxy holds when it opens: the mentions already in the perspective. */
let opening: unknown = { instances: [] }
class FakeProxy {
  callbacks: Array<(r: unknown) => void> = []
  result: unknown = opening
  constructor(
    public uuid: string,
    public query: string,
    public client: unknown,
    public className?: string
  ) {
    proxies.push(this)
  }
  subscribe = async () => {}
  get initialized() {
    return Promise.resolve(true)
  }
  onResult(cb: (r: unknown) => void) {
    this.callbacks.push(cb)
    return () => {}
  }
  dispose() {}
  push(r: unknown) {
    this.result = r
    for (const cb of this.callbacks) cb(r)
  }
}

function fixture(
  perspectives: Array<{ uuid: string; sharedUrl?: string }>,
  watchedFile?: string,
  existing: unknown[] = []
) {
  opening = { instances: existing }
  const emitted: Array<{ type: string; payload: any }> = []
  const bus = { emit: (e: any) => emitted.push(e), on: vi.fn(() => () => {}) } as unknown as EventBus
  const modelQuery = vi.fn(async (_uuid: string, cls: string, q: string) => {
    const scope = JSON.parse(q).parent
    if (cls !== 'ad4m://Container') return { instances: [] }
    return scope.transitive ? { instances: [{ id: 'space://1' }] } : { instances: [{ id: 'channel://1' }] }
  })
  const client = {
    agent: {
      me: vi.fn().mockResolvedValue({ did: DID, perspective: { links: [] } })
    },
    perspective: { all: vi.fn().mockResolvedValue(perspectives), modelQuery },
    on: vi.fn(() => () => {})
  }
  const manager = {
    getClient: () => client,
    isConnected: () => true,
    onConnected: vi.fn(),
    setToken: vi.fn(),
    close: vi.fn()
  }
  proxies.length = 0
  const watcher = startWaker(manager as any, bus, watchedFile, 'Hex', {
    QuerySubscriptionProxy: FakeProxy,
    debounceMs: 0
  })
  return { emitted, watcher, modelQuery }
}

const settle = () => new Promise((r) => setTimeout(r, 30))
const mentionsOf = (emitted: Array<{ type: string; payload: any }>) =>
  emitted.filter((e) => e.type === 'ad4m.thread.message').map((e) => e.payload)

describe('startWaker on the SDK waker', () => {
  it('subscribes every neighbourhood with the TextContent mention query', async () => {
    fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }, { uuid: 'local-1' }])
    await settle()
    expect(proxies).toHaveLength(1)
    expect(proxies[0]).toMatchObject({ uuid: 'n-1', className: 'ad4m://TextContent' })
  })

  it('takes what a new subscription opens on as history, then wakes on a new whole-word mention with its parents', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }], undefined, [
      { id: 'msg://old', text: 'hi Hex' }
    ])
    await settle()
    const proxy = proxies[0]
    expect(mentionsOf(emitted)).toHaveLength(0)

    proxy.push({
      instances: [
        { id: 'msg://old', text: 'hi Hex' },
        { id: 'msg://word', text: 'look at the hexagon' },
        { id: 'msg://new', text: 'Hex, can you join the call?' }
      ]
    })
    await settle()
    const woken = mentionsOf(emitted)
    expect(woken).toHaveLength(1)
    expect(woken[0].context).toEqual({
      perspectiveUuid: 'n-1',
      channelAddress: 'channel://1',
      messageAddress: 'msg://new',
      body: 'Hex, can you join the call?'
    })
    expect(woken[0].text).toContain('Hex, can you join the call?')
    expect(woken[0].text).toContain('space://1')
  })

  it('keeps a perspective’s seen mentions from the old per-uuid state across the move to subscription ids', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-')), 'ad4m-watched.json')
    fs.writeFileSync(file, JSON.stringify({ watched: [], seenMessages: { 'n-1': ['msg://seen'] } }))
    // A restart: the opening result is checked against what was delivered before.
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }], file, [
      { id: 'msg://seen', text: 'Hex?' }
    ])
    await settle()
    expect(mentionsOf(emitted)).toHaveLength(0)
    proxies[0].push({
      instances: [
        { id: 'msg://seen', text: 'Hex?' },
        { id: 'msg://next', text: 'Hex!' }
      ]
    })
    await settle()
    expect(mentionsOf(emitted).map((m) => m.context.messageAddress)).toEqual(['msg://next'])
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(saved.seenMessages['mention-n-1']).toEqual(expect.arrayContaining(['msg://seen', 'msg://next']))
  })

  it('a user watch subscribes a perspective that is not a neighbourhood, and unwatch drops it', async () => {
    const { watcher } = fixture([{ uuid: 'local-1' }])
    await settle()
    expect(proxies).toHaveLength(0)
    watcher.watchPerspective('local-1', 'my-thread', 'Mine')
    await settle()
    expect(proxies.map((p) => p.uuid)).toEqual(['local-1'])
    watcher.unwatchPerspective('local-1')
    expect(watcher.getWatched()).toEqual([])
  })
})
