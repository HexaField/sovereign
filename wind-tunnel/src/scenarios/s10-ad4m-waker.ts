// S10: AD4M mention waker, end to end, with two agents (ad4m #1557, WE #366).
//
// Only runs in the ad4m lane (`run.sh --ad4m`: docker-compose.ad4m.yml + the
// provision step). Otherwise it self-skips as a pass.
//
// Topology (ad4m/provision.mjs): one multi-user executor, two users, one
// neighbourhood over the server-link-language and the lane's link-server.
//   Hex  — Sovereign's agent (the waker connects with its JWT); published the
//          neighbourhood.
//   Alex — a WE user with its own DID; joined it by URL, so it writes into the
//          perspective Hex's waker watches, every link signed by Alex.
//
// Alex registers WE-shaped classes and writes records through them over the
// executor's MCP (`instance_create`), as WE's Ad4mModel does:
//   TextBlock — WE's text block: `text` (we://text), `source` (we://text_source),
//               `mentions` (we://mention), conforming to TextContent by name
//   Note      — another app: `content` aliased to text, `cc` aliased to mentions
//   Chat      — text only, no mention relation
//   Post      — a post root with `mentions` and no text (the known gap)
//   CollectionBlock — a composed record's root (`kind`, `mentions`), no text:
//               a post comment is one of kind "reply"
// TextBlock, Post and CollectionBlock carry `responses` (we://response), as
// WE's WeNode does: a reply hangs off what it answers, never under it.
//
// Each case asserts on the real Sovereign: the mock LLM log shows a presence
// turn whose message says it was mentioned, naming the item and its author
// (Alex), and the presence-internal thread history holds the wake exactly once;
// or no such turn and no such history entry within a fair window, after which a
// control mention proves the waker was live all along.

import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Scenario, ScenarioContext, ScenarioResult } from '../scenario.js'
// @ts-expect-error — plain .mjs helper shared with the docker provision step
import { McpClient } from '../../ad4m/mcp-client.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROVISION = path.resolve(HERE, '../../ad4m/.provision/provision.json')
const MARKER = 'SWT_AD4M_REPLY_OK'
const REPLY_TOOL = 'mcp__sovereign__presence_reply_ad4m'
/** A DID that is not Sovereign's, for a mention of someone else. */
const OTHER_DID = 'did:key:z6MkwindTunnelSomeoneElseEntirely'
const WAKE_TIMEOUT_MS = 90_000
/** The quiet window a no-wake case must stay quiet for, at least. */
const MIN_QUIET_MS = 20_000

interface Agent {
  jwt: string
  did: string
  uuid: string
}
interface Provision extends Agent {
  channel: string
  neighbourhoodUrl?: string
  user?: Agent & { name?: string }
}

function loadProvision(): Provision | null {
  const file = process.env.AD4M_PROVISION_FILE || DEFAULT_PROVISION
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (p?.jwt && p?.uuid && p?.channel) return p
  } catch {
    /* lane not active */
  }
  return null
}

const skip = (summary: string): ScenarioResult => ({ passed: true, summary, metrics: { skipped: true }, samples: [] })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── WE-shaped classes (ad4m rust-executor/src/mcp/tools/instances/tests.rs) ──

const setter = (predicate: string) => [{ action: 'setSingleTarget', source: 'this', predicate, target: 'value' }]
const relation = (predicate: string) => ({
  node_kind: 'IRI',
  relation_kind: 'hasMany',
  collection: true,
  adder: [{ action: 'addLink', source: 'this', predicate, target: 'value' }],
  remover: [{ action: 'removeLink', source: 'this', predicate, target: 'value' }]
})
const flagged = (predicate: string, value: string) => ({
  constructor_actions: [{ action: 'addLink', source: 'this', predicate, target: value }]
})

/** WE's TextBlock (we_shapes/text_block.json, cut to what a mention needs):
 *  conforms to TextContent by its property names `text` and `mentions`. */
const TEXT_BLOCK = {
  target_class: 'we://TextBlock',
  ...flagged('we://flag', 'we://text_block'),
  properties: [
    {
      path: 'we://flag',
      name: 'flag',
      datatype: 'xsd://string',
      min_count: 1,
      max_count: 1,
      has_value: 'we://text_block',
      writable: false
    },
    {
      path: 'we://text',
      name: 'text',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: setter('we://text')
    },
    {
      path: 'we://text_source',
      name: 'source',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: setter('we://text_source')
    },
    { path: 'we://mention', name: 'mentions', ...relation('we://mention') },
    { path: 'we://response', name: 'responses', ...relation('we://response') }
  ]
}
/** Another app's class (MENTION_NOTE_SDNA): its own predicates, aliased. */
const NOTE = {
  target_class: 'app://Note',
  ...flagged('app://kind', 'app://note'),
  properties: [
    { path: 'app://kind', name: 'kind', has_value: 'app://note', min_count: 1, max_count: 1 },
    {
      path: 'app://content',
      name: 'content',
      datatype: 'xsd:string',
      min_count: 1,
      max_count: 1,
      writable: true,
      setter: setter('app://content'),
      alias: { TextContent: 'text' }
    },
    { path: 'app://cc', name: 'cc', ...relation('app://cc'), alias: { TextContent: 'mentions' } }
  ]
}
/** A chat line with text and no mention relation (TEXT_ONLY_CHAT_SDNA). */
const CHAT = {
  target_class: 'app://Chat',
  ...flagged('app://chat_kind', 'app://chat'),
  properties: [
    { path: 'app://chat_kind', name: 'kind', has_value: 'app://chat', min_count: 1, max_count: 1 },
    {
      path: 'app://chat_text',
      name: 'text',
      datatype: 'xsd:string',
      max_count: 1,
      writable: true,
      setter: setter('app://chat_text')
    }
  ]
}
/** A WE post root: mentions, no text of its own (its text is in child blocks). */
const POST = {
  target_class: 'we://Post',
  ...flagged('we://flag', 'we://post'),
  properties: [
    {
      path: 'we://flag',
      name: 'flag',
      datatype: 'xsd://string',
      min_count: 1,
      max_count: 1,
      has_value: 'we://post',
      writable: false
    },
    { path: 'we://mention', name: 'mentions', ...relation('we://mention') },
    { path: 'we://response', name: 'responses', ...relation('we://response') }
  ]
}
/** WE's CollectionBlock, cut down: a composed record's root (a post comment is
 *  one with kind "reply"), `mentions` and `responses`, no text of its own. */
const COLLECTION_BLOCK = {
  target_class: 'we://CollectionBlock',
  ...flagged('we://flag', 'we://collection_block'),
  properties: [
    {
      path: 'we://flag',
      name: 'flag',
      datatype: 'xsd://string',
      min_count: 1,
      max_count: 1,
      has_value: 'we://collection_block',
      writable: false
    },
    {
      path: 'we://collection_kind',
      name: 'kind',
      datatype: 'xsd://string',
      max_count: 1,
      writable: true,
      setter: setter('we://collection_kind')
    },
    { path: 'we://mention', name: 'mentions', ...relation('we://mention') },
    { path: 'we://response', name: 'responses', ...relation('we://response') }
  ]
}
const CLASSES: Array<[string, object]> = [
  ['TextBlock', TEXT_BLOCK],
  ['Note', NOTE],
  ['Chat', CHAT],
  ['Post', POST],
  ['CollectionBlock', COLLECTION_BLOCK]
]

// ── Cases ──────────────────────────────────────────────────────────────────────

interface CaseResult {
  id: string
  name: string
  expect: 'wake' | 'none'
  address: string
  passed: boolean
  latencyMs?: number
  /** Wakes the presence-internal history holds for the item. */
  deliveries?: number
  author?: string
  /** The wake's `Parents:` line. */
  parents?: string
  note?: string
}

let seq = 0
/** Create an instance; `parent` puts it under that node, none leaves it loose
 *  (a reply hangs off what it answers, never under it). */
async function create(
  mcp: any,
  uuid: string,
  className: string,
  properties: Record<string, unknown>,
  parent?: string
): Promise<string> {
  const address = `we://swt-s10/${Date.now().toString(36)}-${++seq}`
  const r = await mcp.callToolJson('instance_create', {
    perspective_id: uuid,
    class_name: className,
    base_uri: address,
    ...(parent ? { parent } : {}),
    properties
  })
  if (r?.created !== true) throw new Error(`instance_create ${className} failed: ${JSON.stringify(r).slice(0, 300)}`)
  return address
}

/** Add `item` to a collection of an existing instance, through its class. */
async function addTo(
  mcp: any,
  uuid: string,
  className: string,
  owner: string,
  collection: string,
  item: string
): Promise<void> {
  const r = await mcp.callToolJson('instance_add_to_collection', {
    perspective_id: uuid,
    class_name: className,
    base_uri: owner,
    collection,
    item_uri: item
  })
  if (r?.success !== true)
    throw new Error(`add ${item} to ${className}.${collection} failed: ${JSON.stringify(r).slice(0, 300)}`)
}

/** A reply as WE's transcribe module writes it (`writeMessage({ id, relation:
 *  'responses' }, text, marks)`): a TextBlock hung off the answered record
 *  through its `responses` (we://response), then the host adds a we://mention
 *  link per mention mark (linkNewMentions). */
async function writeReply(
  mcp: any,
  uuid: string,
  answered: { className: string; address: string },
  text: string,
  mentions: string[] = []
): Promise<string> {
  const reply = await create(mcp, uuid, 'TextBlock', { text, source: 'typed' })
  await addTo(mcp, uuid, answered.className, answered.address, 'responses', reply)
  for (const did of mentions) await addTo(mcp, uuid, 'TextBlock', reply, 'mentions', did)
  return reply
}

/** The text blocks of a mock request's user messages. */
function userTexts(entry: any): string[] {
  const out: string[] = []
  for (const m of entry?.messages ?? []) {
    if (m?.role !== 'user') continue
    if (typeof m.content === 'string') out.push(m.content)
    else for (const b of m.content ?? []) if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out
}

async function mockLog(mockLlmUrl: string): Promise<any[]> {
  const log = await fetch(`${mockLlmUrl}/mock/log`)
    .then((r) => r.json())
    .catch(() => [])
  return Array.isArray(log) ? log : (log?.requests ?? [])
}

/** The first presence turn the mock saw that was woken for `address`: its time
 *  and the wake text, or undefined. */
async function wakeTurn(
  mockLlmUrl: string,
  address: string
): Promise<{ at: number; text: string; tools: string } | undefined> {
  for (const e of await mockLog(mockLlmUrl)) {
    const text = userTexts(e).find((t) => t.includes('You were mentioned') && t.includes(`Item: ${address}`))
    if (text) return { at: e.timestamp, text, tools: JSON.stringify(e?.tools ?? '') }
  }
  return undefined
}

/** How many user turns in the presence-internal thread carry a wake for `address`. */
async function deliveries(client: any, internalId: string, address: string): Promise<number> {
  const h = await client.threadHistory(internalId).catch(() => null)
  const turns: any[] = h?.turns ?? (Array.isArray(h) ? h : [])
  return turns.filter((t) => t?.role === 'user' && JSON.stringify(t).split(`Item: ${address}`).length > 1).length
}

async function waitForWake(mockLlmUrl: string, address: string, timeoutMs = WAKE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const w = await wakeTurn(mockLlmUrl, address)
    if (w) return w
    await sleep(1000)
  }
  return undefined
}

async function waitForDeliveries(client: any, internalId: string, address: string, atLeast = 1, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let n = 0
  while (Date.now() < deadline) {
    n = await deliveries(client, internalId, address)
    if (n >= atLeast) return n
    await sleep(1000)
  }
  return n
}

/** The author line of a wake text (`By: <did> …`). */
const authorOf = (text: string) => /^By: (\S+)/m.exec(text)?.[1]

export const s10Ad4mWaker: Scenario = {
  id: 's10',
  name: 'AD4M Waker',
  description:
    'Two agents in one neighbourhood: WE-shaped mentions by another agent wake the presence agent once (link, name, DID, alias, text-only), substrings, other DIDs and its own writes never do, delivery survives a restart, and its reply lands in the channel',

  async run(ctx: ScenarioContext): Promise<ScenarioResult> {
    const { client, mockLlmUrl, composeFile } = ctx
    const prov = loadProvision()
    if (!prov) return skip('skipped — ad4m lane not active (no provision manifest)')

    const mcpUrl = process.env.AD4M_MCP_URL || 'http://localhost:14561'
    const metrics: Record<string, unknown> = { uuid: prov.uuid, channel: prov.channel, mcpUrl }
    const hexMcp = new McpClient(mcpUrl, prov.jwt)
    // A stale manifest from a torn-down lane must not fail a plain run — if the
    // node is unreachable, the lane is not active, so skip.
    try {
      await hexMcp.initialize('swt-s10-hex')
    } catch {
      return skip(`skipped — ad4m node unreachable at ${mcpUrl}`)
    }
    const fail = (summary: string): ScenarioResult => ({ passed: false, summary, metrics, samples: client.samples })
    if (!prov.user?.jwt) return fail('provision manifest has no second (WE user) agent — rebuild the lane')
    const user = prov.user
    const alex = new McpClient(mcpUrl, user.jwt)
    await alex.initialize('swt-s10-alex')
    metrics.hexDid = prov.did
    metrics.alexDid = user.did
    metrics.neighbourhoodUrl = prov.neighbourhoodUrl
    metrics.samePerspective = user.uuid === prov.uuid

    // 0. Sovereign's ad4m client connected and its DID resolved.
    if (!(await waitForAd4mReady(client))) return fail('ad4m client never connected (status.connected stayed false)')
    const internalId: string | undefined = (await client.presenceThreads().catch(() => null))?.internal?.id
    if (!internalId) return fail('no presence-internal thread')
    metrics.internalThread = internalId

    // 1. Alex registers the WE-shaped classes in the neighbourhood.
    for (const [name, shape] of CLASSES) {
      const r: any = await client.timed(`add-model-${name}`, () =>
        alex.callToolJson('add_model', {
          perspective_id: user.uuid,
          class_name: name,
          shacl_json: JSON.stringify(shape)
        })
      )
      if (r?.success !== true) return fail(`Alex could not register ${name}: ${JSON.stringify(r).slice(0, 200)}`)
    }

    // 2. The first wake answers with presence_reply_ad4m (once, so the follow-up turn ends).
    //    Registered per item below, once its address is known.
    const scriptReply = (address: string) =>
      fetch(`${mockLlmUrl}/mock/script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern: `Item: ${address.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`,
          once: true,
          toolUse: { id: 'toolu_s10', name: REPLY_TOOL, input: { text: `${MARKER} acknowledged the mention` } }
        })
      }).then((r) => r.json())

    // 3. Pin the perspective for the waker, and let its subscription open on the
    //    (empty) perspective and boot turns settle before anything is written.
    metrics.watch = await client.timed('watch-perspective', () =>
      client.post('/api/ad4m/watch/perspectives', { uuid: prov.uuid, label: 's10' })
    )
    await sleep(5000)
    await waitForIdle(client)

    const cases: CaseResult[] = []
    const P = prov.channel

    /** Write a record and wait for it to wake the presence agent, by Alex. */
    async function expectWake(
      id: string,
      name: string,
      write: () => Promise<string>,
      opts: { reply?: boolean; author?: string } = {}
    ): Promise<CaseResult> {
      const t0 = Date.now()
      let address = ''
      try {
        address = await client.timed(`${id}-write`, write)
      } catch (e: any) {
        const r: CaseResult = { id, name, expect: 'wake', address, passed: false, note: `write failed: ${e?.message}` }
        cases.push(r)
        return r
      }
      const wake = await waitForWake(mockLlmUrl, address)
      const r: CaseResult = { id, name, expect: 'wake', address, passed: false }
      if (!wake) {
        r.note = `no presence turn named ${address} within ${WAKE_TIMEOUT_MS / 1000}s`
        cases.push(r)
        return r
      }
      r.latencyMs = wake.at - t0
      r.author = authorOf(wake.text)
      r.parents = /^Parents: (.*)$/m.exec(wake.text)?.[1]
      r.deliveries = await waitForDeliveries(client, internalId!, address)
      const author = opts.author ?? user.did
      const problems: string[] = []
      if (r.author !== author) problems.push(`author ${r.author ?? 'missing'}, expected ${author}`)
      if (!/\(signature verified\)/.test(wake.text)) problems.push('mention not marked verified')
      if (r.deliveries !== 1) problems.push(`${r.deliveries} deliveries`)
      if (opts.reply && !wake.tools.includes('presence_reply_ad4m'))
        problems.push('turn not offered presence_reply_ad4m')
      r.passed = problems.length === 0
      if (problems.length) r.note = problems.join('; ')
      cases.push(r)
      return r
    }

    // ── Wakes ──────────────────────────────────────────────────────────────────
    // 1. A WE chip: the label runs into the next word, the mention link names Hex.
    await expectWake(
      '1-chip',
      'WE chip mention (link to DID, label "@Hexi")',
      async () => {
        const address = `we://swt-s10/chip-${Date.now().toString(36)}`
        await scriptReply(address)
        const r = await alex.callToolJson('instance_create', {
          perspective_id: user.uuid,
          class_name: 'TextBlock',
          base_uri: address,
          parent: P,
          properties: { text: '@Hexi can you look at this', mentions: [prov.did] }
        })
        if (r?.created !== true) throw new Error(JSON.stringify(r).slice(0, 300))
        return address
      },
      { reply: true }
    )
    // The reply write-back: presence_reply_ad4m lands as a fresh child of the channel.
    const replyLanded = await client.timed('reply-landed', async () => {
      for (let i = 0; i < 40; i++) {
        if (await channelHasReply(hexMcp, prov.uuid, P, MARKER)) return true
        await sleep(1500)
      }
      return false
    })
    metrics.replyLanded = replyLanded
    if (!replyLanded) {
      cases[cases.length - 1].passed = false
      cases[cases.length - 1].note = [
        cases[cases.length - 1].note,
        'presence_reply_ad4m write-back never landed in the channel'
      ]
        .filter(Boolean)
        .join('; ')
    }
    await waitForIdle(client)

    await expectWake('2-name', 'Plain text by name, no link', () =>
      create(alex, user.uuid, 'TextBlock', { text: 'Hex, can you check the build?' }, P)
    )
    await expectWake('3-did', 'The DID in text, no link', () =>
      create(alex, user.uuid, 'TextBlock', { text: `ping ${prov.did} about the deploy` }, P)
    )
    await expectWake('4-spoken', 'Spoken transcript line (source "spoken")', () =>
      create(alex, user.uuid, 'TextBlock', { text: 'hey Hex what do you think', source: 'spoken' }, P)
    )
    await expectWake('8-alias', 'Another app class, its own predicate aliased to mentions', () =>
      create(alex, user.uuid, 'Note', { content: 'please review the roadmap', cc: [prov.did] }, P)
    )
    await expectWake('9-text-only', 'Text-only class (no mentions relation), name in text', () =>
      create(alex, user.uuid, 'Chat', { text: 'Hex are you around?' }, P)
    )
    await expectWake('10-both', 'Mention link and the name in text: wakes exactly once', () =>
      create(alex, user.uuid, 'TextBlock', { text: 'Hex, see what @Hex wrote', mentions: [prov.did] }, P)
    )

    // ── Replies (WE: a reply hangs off what it answers via we://response) ──────
    // R1. A feed reply with a chip: the label runs into the next word ("@Hexo"),
    //     so only the mention link, added after the reply, can wake.
    const r1 = await expectWake(
      'R1-reply-chip',
      'Feed reply (we://response) with a chip: label "@Hexo" + mention link',
      async () => {
        const line = await create(
          alex,
          user.uuid,
          'TextBlock',
          { text: 'the deploy finished overnight', source: 'typed' },
          P
        )
        return writeReply(alex, user.uuid, { className: 'TextBlock', address: line }, '@Hexo yes, see the log', [
          prov.did
        ])
      }
    )
    // A reply is not a has_child child, so its Parents line is expected to read
    // "(unknown)" (a known follow-up): reported, not asserted.
    metrics.r1Parents = r1.parents
    r1.note = [r1.note, `Parents: ${r1.parents ?? 'n/a'}`].filter(Boolean).join('; ')
    // R2. A feed reply naming Hex in plain text, no mention link.
    await expectWake('R2-reply-name', 'Feed reply (we://response) naming Hex in text, no link', async () => {
      const line = await create(
        alex,
        user.uuid,
        'TextBlock',
        { text: 'opened the fix for the flaky test', source: 'typed' },
        P
      )
      return writeReply(alex, user.uuid, { className: 'TextBlock', address: line }, 'thanks Hex, merged')
    })

    // ── No wakes ───────────────────────────────────────────────────────────────
    const quiet: CaseResult[] = []
    const t0 = Date.now()
    const writeQuiet = async (id: string, name: string, write: () => Promise<string>, note?: string) => {
      try {
        quiet.push({ id, name, expect: 'none', address: await client.timed(`${id}-write`, write), passed: false, note })
      } catch (e: any) {
        quiet.push({ id, name, expect: 'none', address: '', passed: false, note: `write failed: ${e?.message}` })
      }
    }
    await writeQuiet('5-substring', 'Substring only ("hexagon")', () =>
      create(alex, user.uuid, 'TextBlock', { text: 'the hexagon tiles are done' }, P)
    )
    await writeQuiet('6-other-did', 'Mention link to another DID, neutral text', () =>
      create(alex, user.uuid, 'TextBlock', { text: 'see the attached draft', mentions: [OTHER_DID] }, P)
    )
    await writeQuiet('7-own', 'Sovereign’s own agent mentions itself', () =>
      create(hexMcp, prov.uuid, 'TextBlock', { text: 'Hex, note to self: check the build', mentions: [prov.did] }, P)
    )
    await writeQuiet(
      '12-post-root-gap',
      'KNOWN GAP: post root with only a mention link, its text in a child block',
      async () => {
        const post = await create(alex, user.uuid, 'Post', { mentions: [prov.did] }, P)
        await create(alex, user.uuid, 'TextBlock', { text: 'here is the plan for next week' }, post)
        return post
      },
      'known gap: a mention on a record with no text of its own does not wake (follow-up PR planned)'
    )
    // R3. A post comment, composed like a post: a CollectionBlock root of kind
    //     "reply" hung off the post through we://response, its words in a child
    //     TextBlock that does not name Hex, the mention link on the root.
    await writeQuiet(
      'R3-comment-gap',
      'KNOWN GAP: post comment root with only a mention link',
      async () => {
        const post = await create(alex, user.uuid, 'Post', {}, P)
        await create(alex, user.uuid, 'TextBlock', { text: 'draft of the launch notes' }, post)
        const comment = await create(alex, user.uuid, 'CollectionBlock', { kind: 'reply' })
        await addTo(alex, user.uuid, 'Post', post, 'responses', comment)
        await create(
          alex,
          user.uuid,
          'TextBlock',
          { text: 'looks good, one typo in the intro', source: 'typed' },
          comment
        )
        await addTo(alex, user.uuid, 'CollectionBlock', comment, 'mentions', prov.did)
        return comment
      },
      'known gap: a comment root carries the mention but no text, so it does not conform to TextContent'
    )
    // A fair window: at least MIN_QUIET_MS, and three times the slowest wake above.
    const slowest = Math.max(0, ...cases.map((c) => c.latencyMs ?? 0))
    const window = Math.max(MIN_QUIET_MS, 3 * slowest)
    metrics.quietWindowMs = window
    await sleep(Math.max(0, window - (Date.now() - t0)))
    // Then a control mention proves the waker was live through the window.
    const control = await expectWake('control', 'Control mention after the quiet window', () =>
      create(alex, user.uuid, 'TextBlock', { text: 'Hex, one more thing' }, P)
    )
    for (const q of quiet) {
      if (!q.address) {
        cases.push(q)
        continue
      }
      const wake = await wakeTurn(mockLlmUrl, q.address)
      q.deliveries = await deliveries(client, internalId, q.address)
      q.passed = !wake && q.deliveries === 0 && control.passed
      if (wake || q.deliveries)
        q.note = `woke (${q.deliveries} deliveries)${/^(12|R3)-/.test(q.id) ? ' — the gap looks closed: make this a wake case' : ''}`
      else if (!control.passed) q.note = 'control mention did not wake, so the quiet window proves nothing'
      cases.push(q)
    }

    // ── 11. A restart delivers nothing twice ───────────────────────────────────
    const delivered = cases.filter((c) => c.expect === 'wake' && c.passed)
    const restart: CaseResult = {
      id: '11-restart',
      name: 'No mention delivered twice after Sovereign restarts',
      expect: 'wake',
      address: '',
      passed: false
    }
    try {
      await waitForIdle(client)
      execSync(`docker compose -f "${composeFile}" restart sovereign`, { encoding: 'utf-8', timeout: 60_000 })
      await waitForHealth(client)
      if (!(await waitForAd4mReady(client))) throw new Error('ad4m client never reconnected after the restart')
      // The waker re-opens its subscription on everything above; let it.
      await sleep(10_000)
      const after = await expectWake('11-after-restart', 'A new mention after the restart', () =>
        create(alex, user.uuid, 'TextBlock', { text: 'Hex, welcome back' }, P)
      )
      const twice: string[] = []
      for (const c of delivered) {
        const n = await deliveries(client, internalId, c.address)
        if (n !== 1) twice.push(`${c.id}: ${n}`)
      }
      restart.address = after.address
      restart.deliveries = after.deliveries
      restart.passed = after.passed && twice.length === 0
      restart.note = twice.length
        ? `re-delivered: ${twice.join(', ')}`
        : `${delivered.length} earlier mentions still delivered once; new one woke`
    } catch (e: any) {
      restart.note = `restart failed: ${e?.message}`
    }
    cases.push(restart)

    metrics.cases = cases.map(({ id, passed, latencyMs, deliveries: n, author, note }) => ({
      id,
      passed,
      latencyMs,
      deliveries: n,
      author: author === user.did ? 'Alex' : author,
      note
    }))
    // The runner prints no metrics: log each case, so a run is its own evidence.
    console.log(`    s10 — Hex ${prov.did}, Alex ${user.did}, same perspective: ${metrics.samePerspective}`)
    for (const c of cases) {
      const by = c.author ? ` by ${c.author === user.did ? 'Alex' : c.author}` : ''
      const timing = c.latencyMs !== undefined ? ` ${(c.latencyMs / 1000).toFixed(1)}s` : ''
      const n = c.deliveries !== undefined ? ` ×${c.deliveries}` : ''
      console.log(
        `    ${c.passed ? '✓' : '✗'} ${c.id.padEnd(18)} ${c.expect === 'wake' ? 'wake' : 'none'}${timing}${n}${by} — ${c.name}${c.note ? ` [${c.note}]` : ''}`
      )
    }
    const failed = cases.filter((c) => !c.passed)
    const latencies = cases.map((c) => c.latencyMs).filter((n): n is number => typeof n === 'number')
    metrics.wakeLatencyMs = {
      min: Math.min(...latencies),
      max: Math.max(...latencies),
      mean: Math.round(latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length))
    }
    if (failed.length) {
      return fail(
        `${failed.length}/${cases.length} cases failed: ${failed.map((c) => `${c.id} (${c.note ?? 'failed'})`).join('; ')}`
      )
    }
    return {
      passed: true,
      summary: `${cases.length} cases: ${cases.filter((c) => c.expect === 'wake').length} wakes named the item and Alex once each, ${quiet.length} stayed quiet for ${Math.round(window / 1000)}s (incl. the known post-root and post-comment gaps), R1 Parents: ${metrics.r1Parents ?? 'n/a'}, nothing re-delivered after a restart, reply landed`,
      metrics,
      samples: client.samples
    }
  }
}

/** Poll /api/ad4m/status until the ad4m client is connected and the agent DID
 *  has resolved — survives a container restart earlier in the suite. */
async function waitForAd4mReady(client: any, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const s = await client.get('/api/ad4m/status')
      if (s?.connected && s?.did) return true
    } catch {
      /* transient — retry */
    }
    await sleep(2000)
  }
  return false
}

async function waitForHealth(client: any, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await client.health()
      return
    } catch {
      await sleep(2000)
    }
  }
  throw new Error('Sovereign never came back healthy')
}

/** Wait until no thread reports an in-flight turn (or a timeout), so the
 *  presence turn runs alone and its session owns `activeSessionKey`. */
async function waitForIdle(client: any, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const threads = await client.listThreads({ includeArchived: true })
      const busy = (Array.isArray(threads) ? threads : []).some((t: any) =>
        ['working', 'thinking'].includes(String(t?.agentStatus ?? '').toLowerCase())
      )
      if (!busy) return
    } catch {
      /* transient — retry */
    }
    await sleep(3000)
  }
}

/** True when a child of `channel` carries the marker in its body. */
async function channelHasReply(mcp: any, uuid: string, channel: string, marker: string): Promise<boolean> {
  const kids = await mcp.callToolJson('query_links', { perspective_id: uuid, source: channel })
  const targets = [...new Set([...JSON.stringify(kids).matchAll(/"target":"([^"]+)"/g)].map((m) => m[1]))]
  for (const t of targets) {
    const links = await mcp.callToolJson('query_links', { perspective_id: uuid, source: t })
    if (JSON.stringify(links).includes(marker)) return true
  }
  return false
}
