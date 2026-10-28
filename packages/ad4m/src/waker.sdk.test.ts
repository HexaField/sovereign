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
const ALEX = 'did:key:z6MkAlex'
const AT = '2026-10-28T01:02:03.000Z'

/** A link as a #1557 model row carries it under `__links`. */
const link = (target: string, author = ALEX, valid = true) => ({
  author,
  timestamp: AT,
  data: { target },
  proof: { valid }
})
const lit = (s: string) => `literal:string:${encodeURIComponent(s)}`
/** A TextContent row as the executor's mention query returns it. */
const row = (id: string, text: string, opts: { author?: string; mentions?: string[]; valid?: boolean } = {}) => ({
  id,
  text,
  __links: {
    text: text ? [link(lit(text), opts.author ?? ALEX, opts.valid ?? true)] : [],
    mentions: (opts.mentions ?? []).map((m) => link(m, opts.author ?? ALEX, opts.valid ?? true))
  }
})

describe('mentionSubscription', () => {
  it('mirrors the executor’s build_mention_query: the mentions branch, a text branch per term, never the agent’s own links', () => {
    const sub = mentionSubscription('p-1', { did: DID, names: ['Hex', '', 'Hex'] })
    expect(sub).toMatchObject({
      id: 'mention-p-1',
      type: 'mention',
      perspective: 'p-1',
      className: 'ad4m://TextContent',
      terms: ['Hex', DID],
      did: DID
    })
    const notMe = { not: DID }
    expect(JSON.parse(sub.query)).toEqual({
      where: {
        OR: [
          { mentions: { eq: DID, author: notMe } },
          { text: { contains: 'Hex', author: notMe } },
          { text: { contains: DID, author: notMe } }
        ]
      },
      order: { timestamp: 'DESC' },
      limit: 50,
      properties: ['text'],
      links: ['mentions', 'text']
    })
  })

  it('with no name still carries the mention relation and the DID', () => {
    const sub = mentionSubscription('p-2', { did: DID, names: [] })
    expect(sub.terms).toEqual([DID])
    expect(JSON.parse(sub.query).where.OR).toHaveLength(2)
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
      row('msg://old', 'hi Hex')
    ])
    await settle()
    const proxy = proxies[0]
    expect(mentionsOf(emitted)).toHaveLength(0)

    proxy.push({
      instances: [
        row('msg://old', 'hi Hex'),
        row('msg://word', 'look at the hexagon'),
        row('msg://new', 'Hex, can you join the call?')
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
    // Who mentioned it, from the text link's provenance.
    expect(woken[0].text).toContain(`By: ${ALEX} (signature verified)`)
    expect(woken[0].text).toContain(`At: ${AT}`)
  })

  it('wakes on a mention link to its DID whatever the text says, once when the text names it too', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }])
    await settle()
    proxies[0].push({
      instances: [
        row('block://chip', '@Hexi can you look at this', { mentions: [DID] }),
        row('block://both', 'Hex, see @Hex', { mentions: [DID] }),
        row('block://other', 'see this', { mentions: ['did:key:z6MkSomeoneElse'] }),
        row('block://forged', 'see this', { mentions: [DID], valid: false })
      ]
    })
    await settle()
    const woken = mentionsOf(emitted)
    expect(woken.map((m) => m.context.messageAddress)).toEqual(['block://chip', 'block://both'])
    expect(woken[0].text).toContain(`By: ${ALEX}`)
  })

  it('never wakes on a record the agent wrote itself', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }])
    await settle()
    proxies[0].push({ instances: [row('block://mine', 'Hex, note to self', { author: DID, mentions: [DID] })] })
    await settle()
    expect(mentionsOf(emitted)).toHaveLength(0)
  })

  it('keeps a perspective’s seen mentions from the old per-uuid state across the move to subscription ids', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'waker-')), 'ad4m-watched.json')
    fs.writeFileSync(file, JSON.stringify({ watched: [], seenMessages: { 'n-1': ['msg://seen'] } }))
    // A restart: the opening result is checked against what was delivered before.
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }], file, [row('msg://seen', 'Hex?')])
    await settle()
    expect(mentionsOf(emitted)).toHaveLength(0)
    proxies[0].push({
      instances: [row('msg://seen', 'Hex?'), row('msg://next', 'Hex!')]
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
