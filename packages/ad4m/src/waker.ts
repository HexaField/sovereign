import fs from 'node:fs'
import path from 'node:path'
import { QuerySubscriptionProxy, WakerSubscriptionManager } from '@coasys/ad4m'
import type { MentionMessage, WakerSubscription } from '@coasys/ad4m'
import type { EventBus } from '@sovereign/core'
import type { Ad4mClientManager, Ad4mTypedClient } from './client.js'

// The mention waker: one SDK WakerSubscriptionManager per executor connection
// (whole-word matching, own writes skipped, parents and ancestors through the
// built-in Container, delivery persisted only once it reached the bus), fed one
// mention subscription (a TextContent and a Mentioning model query) per watched perspective. Sovereign adds what is its
// own: which perspectives to watch, the agent's name, and the bus events the
// server turns into a presence-internal message.

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WatchEntry {
  uuid: string
  threadKey: string
  label: string
  /** true = discovered automatically from perspective.all(); false = user-configured */
  autoDiscovered: boolean
}

/** Returned by startWaker — lets callers add/remove watches at runtime. */
export interface WatcherController {
  watchPerspective(uuid: string, threadKey: string, label?: string): void
  unwatchPerspective(uuid: string): void
  getWatched(): WatchEntry[]
}

interface AgentIdentity {
  did: string
  /** Names people use to address the agent. */
  names: string[]
}

// ── Literal target parser ──────────────────────────────────────────────────────

/**
 * Decode an AD4M literal: target to its plain string value.
 *   literal:string:URL_ENCODED_VALUE  → decodeURIComponent(value)
 *   literal:json:URL_ENCODED_JSON     → decodeURIComponent → JSON.parse → .data
 */
export function parseLiteralTarget(target: string): string | null {
  let rest: string | null = null
  let isJson = false
  if (target.startsWith('literal:json:')) {
    rest = target.slice('literal:json:'.length)
    isJson = true
  } else if (target.startsWith('literal:string:')) {
    rest = target.slice('literal:string:'.length)
  }
  if (rest === null) return null
  try {
    const decoded = decodeURIComponent(rest)
    if (!isJson) return decoded.trim()
    const data = JSON.parse(decoded)?.data
    if (typeof data === 'string') return data.trim()
    if (typeof data === 'object' && data !== null) return JSON.stringify(data)
    return null
  } catch {
    return null
  }
}

/** The agent's DID, and the profile names on its public perspective unless a configured name replaces them. */
async function resolveAgentIdentity(client: Ad4mTypedClient, configuredName?: string): Promise<AgentIdentity | null> {
  try {
    const agent = (await client.agent.me()) as any
    const did = agent?.did as string | undefined
    if (!did) return null
    if (configuredName) return { did, names: [configuredName] }
    const NAME_PREDICATES = new Set(['sioc://has_username', 'sioc://has_given_name', 'sioc://has_family_name'])
    const names: string[] = []
    for (const link of agent.perspective?.links ?? []) {
      if (link?.data?.source !== 'flux://profile' || !NAME_PREDICATES.has(link?.data?.predicate ?? '')) continue
      const name = parseLiteralTarget(link?.data?.target ?? '')
      if (name && name.length > 1 && !names.includes(name)) names.push(name)
    }
    return { did, names }
  } catch {
    return null
  }
}

// ── The subscription ───────────────────────────────────────────────────────────

const TEXT_CONTENT = 'ad4m://TextContent'
const MENTIONING = 'ad4m://Mentioning'
/** Newest mentions the query returns (the executor's MENTION_WINDOW). */
const MENTION_WINDOW = 50

/**
 * The mention subscription for one perspective: the executor's
 * `get_mention_waker_config` (rust-executor/src/mcp/tools/subscriptions.rs,
 * `build_mention_query`, `build_mentioning_query` and `mention_terms`), built
 * here because Sovereign talks to the executor over RPC, not MCP. Two model
 * queries over built-in abstract classes, which the SDK manager opens under one
 * id (one wake per record, the first query to report it wins):
 * - `query` over TextContent `{ text }`: a record whose `text` contains a name
 *   or the DID, through a text link another agent wrote (`links: ["text"]`);
 * - `mentionQuery` over Mentioning `{ mentions }`: a record whose `mentions`
 *   relation links the DID (WE's `we://mention` chip, or any predicate a class
 *   aliases to `mentions`, text or not), through a link another agent wrote
 *   (`links: ["mentions"]`).
 * Both newest first, at most `MENTION_WINDOW`. The rows carry their links
 * (`__links`), so the manager can keep only whole-word text matches of `terms`
 * and hand back the mentioning link's author. The SDK refuses a mention
 * subscription without `className`, `terms`, `did`, `mentionClass` and
 * `mentionQuery`.
 */
export function mentionSubscription(perspective: string, identity: AgentIdentity): WakerSubscription {
  const did = identity.did
  const terms = [...new Set([...identity.names, did].filter(Boolean))]
  const notMe = { not: did }
  const query = {
    where: { OR: terms.map((term) => ({ text: { contains: term, author: notMe } })) },
    order: { timestamp: 'DESC' },
    limit: MENTION_WINDOW,
    properties: ['text'],
    links: ['text']
  }
  const mentionQuery = {
    where: { mentions: { eq: did, author: notMe } },
    order: { timestamp: 'DESC' },
    limit: MENTION_WINDOW,
    properties: ['mentions'],
    links: ['mentions']
  }
  return {
    id: `mention-${perspective}`,
    type: 'mention',
    perspective,
    channel: '',
    query: JSON.stringify(query),
    className: TEXT_CONTENT,
    terms,
    did,
    mentionClass: MENTIONING,
    mentionQuery: JSON.stringify(mentionQuery)
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

interface PersistedWatch {
  uuid: string
  threadKey: string
  label: string
}
interface PersistedFile {
  watched: PersistedWatch[]
  /** Delivered mention addresses per subscription id (`mention-<uuid>`); older files key them by uuid. */
  seenMessages: Record<string, string[]>
}

function loadPersisted(file: string): PersistedFile {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PersistedFile>
    const seen: Record<string, string[]> = {}
    for (const [key, ids] of Object.entries(data.seenMessages ?? {})) {
      const id = key.startsWith('mention-') ? key : `mention-${key}`
      seen[id] = [...new Set([...(seen[id] ?? []), ...ids])]
    }
    return { watched: data.watched ?? [], seenMessages: seen }
  } catch {
    return { watched: [], seenMessages: {} }
  }
}

function savePersisted(file: string, data: PersistedFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn('[ad4m] waker: failed to persist state:', e)
  }
}

// ── Bus ────────────────────────────────────────────────────────────────────────

function emitBusEvent(bus: EventBus, type: string, payload: unknown) {
  bus.emit({ type, source: 'ad4m', timestamp: new Date().toISOString(), payload })
}

/** The text of `address` in a TextContent result (`{ instances: [{ id, text }] }`). */
function textOf(result: any, address: string): string | undefined {
  const row = (result?.instances ?? []).find((r: any) => r?.id === address)
  const text = Array.isArray(row?.text) ? row.text.join(' ') : row?.text
  return typeof text === 'string' && text ? text : undefined
}

function mentionText(m: MentionMessage, body: string | undefined): string {
  const lines = [`[AD4M] You were mentioned${body ? `: "${body}"` : ''}`, `Item: ${m.address}`]
  if (m.author) lines.push(`By: ${m.author}${m.verified ? ' (signature verified)' : ' (signature NOT verified)'}`)
  if (m.timestamp) lines.push(`At: ${m.timestamp}`)
  if (m.via)
    lines.push(
      `Matched by: ${m.via === 'mentions' ? 'a mention link' : 'your name or DID in the text; a mention link may also exist'}`
    )
  lines.push(`Parents: ${m.parents.length ? m.parents.join(', ') : '(unknown)'}`)
  if (m.ancestors?.length) lines.push(`Ancestors: ${m.ancestors.join(', ')}`)
  return lines.join('\n')
}

// ── Main ───────────────────────────────────────────────────────────────────────

const logger = {
  info: (m: string) => console.log(`[ad4m] ${m}`),
  warn: (m: string) => console.warn(`[ad4m] ${m}`),
  error: (m: string) => console.error(`[ad4m] ${m}`),
  debug: () => {}
}

export function startWaker(
  clientManager: Ad4mClientManager,
  bus: EventBus,
  /** Path to JSON file for persisting watches and delivered mentions. */
  watchedFile?: string,
  /** The AI agent's name (e.g. "Hex"): people address it by this, not by the human's profile names. */
  configuredAgentName?: string,
  /** Tests: a stand-in for the SDK's live query, and the debounce. */
  opts: { QuerySubscriptionProxy?: unknown; debounceMs?: number } = {}
): WatcherController {
  const userWatches = new Map<string, WatchEntry>()
  const autoWatches = new Map<string, WatchEntry>()
  const persisted: PersistedFile = watchedFile ? loadPersisted(watchedFile) : { watched: [], seenMessages: {} }
  for (const e of persisted.watched) userWatches.set(e.uuid, { ...e, autoDiscovered: false })
  let seen = persisted.seenMessages

  let manager: WakerSubscriptionManager | null = null
  let lastClient: Ad4mTypedClient | null = null
  let identity: AgentIdentity | null = null

  function persistState() {
    if (!watchedFile) return
    savePersisted(watchedFile, {
      watched: [...userWatches.values()].map(({ uuid, threadKey, label }) => ({ uuid, threadKey, label })),
      seenMessages: seen
    })
  }

  function entryOf(uuid: string): WatchEntry | undefined {
    return userWatches.get(uuid) ?? autoWatches.get(uuid)
  }

  function managerFor(client: Ad4mTypedClient): WakerSubscriptionManager {
    return new WakerSubscriptionManager({
      perspectiveClient: client.perspective,
      QuerySubscriptionProxy: opts.QuerySubscriptionProxy ?? QuerySubscriptionProxy,
      logger,
      debounceMs: opts.debounceMs ?? 2000,
      previousSeenMessages: seen,
      onPersist: (_subs, delivered) => {
        seen = { ...seen, ...delivered }
        persistState()
      },
      onWake: (sub, result, mentions) => {
        const entry = entryOf(sub.perspective)
        if (!entry || !mentions?.length) return true
        for (const m of mentions) {
          const body = textOf(result, m.address)
          emitBusEvent(bus, 'ad4m.perspective.mention', { uuid: sub.perspective, ...m, body })
          emitBusEvent(bus, 'ad4m.thread.message', {
            threadKey: entry.threadKey,
            threadLabel: entry.label,
            text: mentionText(m, body),
            context: {
              perspectiveUuid: sub.perspective,
              channelAddress: m.parents[0],
              messageAddress: m.address,
              body
            }
          })
        }
        return true
      }
    })
  }

  function subscribe(uuid: string) {
    if (!manager || !identity) return
    manager.subscribe(mentionSubscription(uuid, identity)).catch((e) => logger.warn(`waker: ${e?.message ?? e}`))
  }

  // On every connect: a new client gets a new manager; then subscribe every watch
  // and every joined neighbourhood.
  async function onConnected() {
    const client = clientManager.getClient()
    if (!client) return
    if (client !== lastClient || !manager) {
      manager?.disposeAll()
      lastClient = client
      identity = null
      manager = managerFor(client)
    }
    if (!identity) {
      identity = await resolveAgentIdentity(client, configuredAgentName)
      if (!identity) {
        logger.warn('waker: could not resolve the agent — no subscriptions')
        return
      }
      logger.info(`waker: agent ...${identity.did.slice(-12)}, names [${identity.names.join(', ') || 'none'}]`)
    }
    const active = new Set(manager.getActive().map((s) => s.perspective))
    for (const uuid of userWatches.keys()) if (!active.has(uuid)) subscribe(uuid)
    try {
      for (const p of await client.perspective.all()) {
        if (!p.sharedUrl || userWatches.has(p.uuid)) continue
        if (!autoWatches.has(p.uuid)) {
          autoWatches.set(p.uuid, {
            uuid: p.uuid,
            threadKey: `ad4m/perspective/${p.uuid}`,
            label: `AD4M Perspective ${p.uuid.slice(0, 8)}`,
            autoDiscovered: true
          })
        }
        if (!active.has(p.uuid)) subscribe(p.uuid)
      }
    } catch (e) {
      logger.warn(`waker: auto-discover failed: ${(e as Error)?.message}`)
    }
  }

  // ── Static subscriptions (agent status and profile, apps, notifications) ──────────
  // The executor has no direct-message event since one `on()` replaced the
  // per-event listeners (ad4m #1193), so there is no `ad4m.dm.received` any more.
  function wireStaticListeners(client: Ad4mTypedClient) {
    client.on('agent-status-changed', (agent) => emitBusEvent(bus, 'ad4m.agent.status_changed', { agent }))
    client.on('agent-updated', (agent) => emitBusEvent(bus, 'ad4m.agent.updated', { agent }))
    client.on('apps-changed', () => emitBusEvent(bus, 'ad4m.apps.changed', {}))
    client.on('notification-triggered', (notification) =>
      emitBusEvent(bus, 'ad4m.notification.triggered', { notification })
    )
  }

  const initialClient = clientManager.getClient()
  if (initialClient) wireStaticListeners(initialClient)
  clientManager.onConnected(() => {
    const client = clientManager.getClient()
    if (!client) return
    if (client !== lastClient) wireStaticListeners(client)
    onConnected().catch((e) => logger.warn(`waker: onConnected error: ${e}`))
  })
  onConnected().catch(() => {
    /* retried on the next connect */
  })

  return {
    watchPerspective(uuid, threadKey, label) {
      userWatches.set(uuid, { uuid, threadKey, label: label ?? `AD4M: ${threadKey}`, autoDiscovered: false })
      autoWatches.delete(uuid)
      persistState()
      subscribe(uuid)
      logger.info(`waker: watching perspective ${uuid} → thread "${threadKey}"`)
    },
    unwatchPerspective(uuid) {
      userWatches.delete(uuid)
      autoWatches.delete(uuid)
      manager?.dispose(`mention-${uuid}`)
      delete seen[`mention-${uuid}`]
      persistState()
      logger.info(`waker: unwatched perspective ${uuid}`)
    },
    getWatched() {
      return [...userWatches.values(), ...autoWatches.values()]
    }
  }
}
