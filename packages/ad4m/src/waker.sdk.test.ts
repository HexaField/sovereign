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

/** A link as a model row carries it under `__links`. */
const link = (target: string, author = ALEX, valid = true) => ({
  author,
  timestamp: AT,
  data: { target },
  proof: { valid }
})
const lit = (s: string) => `literal:string:${encodeURIComponent(s)}`
/** A TextContent row as the executor's text query returns it (`links: ["text"]`). */
const row = (id: string, text: string, opts: { author?: string; valid?: boolean } = {}) => ({
  id,
  text,
  __links: { text: text ? [link(lit(text), opts.author ?? ALEX, opts.valid ?? true)] : [] }
})
/** A Mentioning row as the executor's mention query returns it (`links: ["mentions"]`). */
const mentionRow = (id: string, mentions: string[], opts: { author?: string; valid?: boolean } = {}) => ({
  id,
  mentions,
  __links: { mentions: mentions.map((m) => link(m, opts.author ?? ALEX, opts.valid ?? true)) }
})

describe('mentionSubscription', () => {
  it('mirrors the executor’s get_mention_waker_config: a TextContent text query and a Mentioning mention query, never the agent’s own links', () => {
    const sub = mentionSubscription('p-1', { did: DID, names: ['Hex', '', 'Hex'] })
    expect(sub).toMatchObject({
      id: 'mention-p-1',
      type: 'mention',
      perspective: 'p-1',
      className: 'ad4m://TextContent',
      terms: ['Hex', DID],
      did: DID,
      mentionClass: 'ad4m://Mentioning'
    })
    const notMe = { not: DID }
    // build_mention_query
    expect(JSON.parse(sub.query)).toEqual({
      where: {
        OR: [{ text: { contains: 'Hex', author: notMe } }, { text: { contains: DID, author: notMe } }]
      },
      order: { timestamp: 'DESC' },
      limit: 50,
      properties: ['text'],
      links: ['text']
    })
    // build_mentioning_query
    expect(JSON.parse(sub.mentionQuery!)).toEqual({
      where: { mentions: { eq: DID, author: notMe } },
      order: { timestamp: 'DESC' },
      limit: 50,
      properties: ['mentions'],
      links: ['mentions']
    })
  })

  it('with no name still carries the DID as a term and the mention query', () => {
    const sub = mentionSubscription('p-2', { did: DID, names: [] })
    expect(sub.terms).toEqual([DID])
    expect(JSON.parse(sub.query).where.OR).toEqual([{ text: { contains: DID, author: { not: DID } } }])
    expect(JSON.parse(sub.mentionQuery!).where).toEqual({ mentions: { eq: DID, author: { not: DID } } })
  })
})

// ── Fakes ──────────────────────────────────────────────────────────────────────

const proxies: FakeProxy[] = []
/** What the text query holds when it opens: the mentions already in the perspective. */
let opening: unknown = { instances: [] }
class FakeProxy {
  callbacks: Array<(r: unknown) => void> = []
  result: unknown
  constructor(
    public uuid: string,
    public query: string,
    public client: unknown,
    public className?: string
  ) {
    this.result = className === MENTIONING ? { instances: [] } : opening
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

const MENTIONING = 'ad4m://Mentioning'
/** The perspective's text query and mention query, as the manager opened them. */
const textProxy = (uuid = 'n-1') => proxies.find((p) => p.uuid === uuid && p.className === 'ad4m://TextContent')!
const mentionProxy = (uuid = 'n-1') => proxies.find((p) => p.uuid === uuid && p.className === MENTIONING)!

const settle = () => new Promise((r) => setTimeout(r, 30))
const mentionsOf = (emitted: Array<{ type: string; payload: any }>) =>
  emitted.filter((e) => e.type === 'ad4m.thread.message').map((e) => e.payload)

describe('startWaker on the SDK waker', () => {
  it('subscribes every neighbourhood with the TextContent text query and the Mentioning mention query', async () => {
    fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }, { uuid: 'local-1' }])
    await settle()
    expect(proxies.map((p) => [p.uuid, p.className])).toEqual([
      ['n-1', 'ad4m://TextContent'],
      ['n-1', MENTIONING]
    ])
    expect(JSON.parse(mentionProxy().query).where).toEqual({ mentions: { eq: DID, author: { not: DID } } })
  })

  it('takes what a new subscription opens on as history, then wakes on a new whole-word mention with its parents', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }], undefined, [
      row('msg://old', 'hi Hex')
    ])
    await settle()
    const proxy = textProxy()
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
    expect(woken[0].text).toContain('Matched by: your name or DID in the text; a mention link may also exist')
  })

  it('wakes on a verified mention link to its DID from the mention query, a text-less root included', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }])
    await settle()
    mentionProxy().push({
      instances: [
        mentionRow('block://chip', [DID]),
        mentionRow('post://root', [DID]),
        mentionRow('block://other', ['did:key:z6MkSomeoneElse']),
        mentionRow('block://forged', [DID], { valid: false })
      ]
    })
    await settle()
    const woken = mentionsOf(emitted)
    expect(woken.map((m) => m.context.messageAddress)).toEqual(['block://chip', 'post://root'])
    expect(woken[0].text).toContain(`By: ${ALEX} (signature verified)`)
    expect(woken[0].text).toContain('Matched by: a mention link')
    // Mentioning rows hold no text, so a wake through the mention query has no body.
    expect(woken[0].context.body).toBeUndefined()
  })

  it('wakes once for a record both queries report, through the first', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }])
    await settle()
    mentionProxy().push({ instances: [mentionRow('block://both', [DID])] })
    await settle()
    textProxy().push({ instances: [row('block://both', 'Hex, see @Hex')] })
    await settle()
    const woken = mentionsOf(emitted)
    expect(woken.map((m) => m.context.messageAddress)).toEqual(['block://both'])
    expect(woken[0].text).toContain('Matched by: a mention link')
  })

  it('never wakes on a record the agent wrote itself', async () => {
    const { emitted } = fixture([{ uuid: 'n-1', sharedUrl: 'neighbourhood://a' }])
    await settle()
    textProxy().push({ instances: [row('block://mine', 'Hex, note to self', { author: DID })] })
    mentionProxy().push({ instances: [mentionRow('block://mine', [DID], { author: DID })] })
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
    textProxy().push({
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
    expect(proxies.map((p) => [p.uuid, p.className])).toEqual([
      ['local-1', 'ad4m://TextContent'],
      ['local-1', MENTIONING]
    ])
    watcher.unwatchPerspective('local-1')
    expect(watcher.getWatched()).toEqual([])
  })
})
