import fs from 'node:fs'
import path from 'node:path'
import { QuerySubscriptionProxy, LinkQuery } from '@coasys/ad4m'
import type { EventBus } from '@sovereign/core'
import type { Ad4mClientManager, Ad4mTypedClient } from './client.js'

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

// ── Literal target parser ──────────────────────────────────────────────────────

/**
 * Decode an AD4M literal: target to its plain string value.
 * Canonical formats produced by current executors:
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
    const obj = JSON.parse(decoded)
    // AD4M expression JSON: { author, timestamp, data, proof }
    const data = obj?.data
    if (typeof data === 'string') return data.trim()
    if (typeof data === 'object' && data !== null) return JSON.stringify(data)
    return null
  } catch {
    return null
  }
}

// ── Agent identity ─────────────────────────────────────────────────────────────

interface AgentIdentity {
  did: string
  /** Profile names from flux://profile links (username, given_name, family_name). */
  names: string[]
}

/**
 * Fetch the agent's DID and, optionally, profile names from their public perspective.
 *
 * Pass skipNames=true when a configuredAgentName is available — the profile
 * name loop is skipped entirely, which avoids any risk of unparsed literal:json:
 * expression blobs leaking into the mention SPARQL query as bogus CONTAINS terms
 * (the same bug present in the executor's get_mention_waker_config tool).
 *
 * Profile links when resolved: source = "flux://profile",
 * predicates = sioc://has_username | sioc://has_given_name | sioc://has_family_name.
 */
async function resolveAgentIdentity(client: Ad4mTypedClient, skipNames = false): Promise<AgentIdentity | null> {
  try {
    const agent = await client.agent.me()
    const did = (agent as any).did as string | undefined
    if (!did) return null

    if (skipNames) return { did, names: [] }

    const names: string[] = []
    const PROFILE_SOURCE = 'flux://profile'
    const NAME_PREDICATES = new Set(['sioc://has_username', 'sioc://has_given_name', 'sioc://has_family_name'])

    for (const link of (agent as any).perspective?.links ?? []) {
      if (link?.data?.source !== PROFILE_SOURCE) continue
      if (!NAME_PREDICATES.has(link?.data?.predicate ?? '')) continue

      const raw: string = link?.data?.target ?? ''
      const parsed = parseLiteralTarget(raw)
      if (parsed && parsed.length > 1 && !names.includes(parsed)) {
        names.push(parsed)
      }
    }

    return { did, names }
  } catch {
    return null
  }
}

// ── Mention SPARQL query ───────────────────────────────────────────────────────

/**
 * Build a SPARQL query that fires only when a message's body target contains
 * the agent's name(s) or DID as a substring.
 *
 * Uses <ad4m://fn/parse_literal> — a built-in AD4M executor function that
 * decodes literal: targets (URL-encoded strings, signed JSON) before CONTAINS
 * matching, ensuring we match against actual message content rather than raw URIs.
 *
 * Mirrors the logic in the AD4M executor's get_mention_waker_config MCP tool
 * (rust-executor/src/mcp/tools/subscriptions.rs).
 */
function buildMentionQuery(identity: AgentIdentity): string {
  const terms = [...new Set([...identity.names.map((n) => n.toLowerCase()), identity.did.toLowerCase()])]

  const conditions = terms.map((t) => `CONTAINS(LCASE(STR(<ad4m://fn/parse_literal>(?target))), "${t}")`).join(' || ')

  return `
    SELECT ?source ?predicate ?target WHERE {
      ?source ?predicate ?target .
      FILTER(isIRI(?source) && isIRI(?predicate))
      FILTER(${conditions})
    }
  `
}

// ── Parent resolution ──────────────────────────────────────────────────────────

/**
 * Given a message node address, find its parent channels/conversations
 * by querying for things that have it as a child via ad4m://has_child.
 */
async function resolveParents(client: Ad4mTypedClient, uuid: string, msgAddr: string): Promise<string[]> {
  try {
    const query = `SELECT ?source WHERE { ?source <ad4m://has_child> <${msgAddr}> . }`
    const result = (await (client.perspective as any).querySparql(uuid, query)) as any
    const bindings: any[] = result?.results?.bindings ?? []
    return bindings.map((b: any) => b?.source?.value as string).filter(Boolean)
  } catch {
    return []
  }
}

// ── Body resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the body text of a message node.
 * Queries all links FROM the message address and returns the first literal string found.
 */
async function resolveChildBody(client: Ad4mTypedClient, uuid: string, msgAddr: string): Promise<string | null> {
  try {
    const links = await client.perspective.queryLinks(uuid, new LinkQuery({ source: msgAddr }))
    for (const link of links ?? []) {
      const body = parseLiteralTarget(link?.data?.target ?? '')
      if (body) return body
    }
  } catch {
    // Body may not have synced yet — not a hard failure
  }
  return null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function emitBusEvent(bus: EventBus, type: string, payload: unknown) {
  bus.emit({ type, source: 'ad4m', timestamp: new Date().toISOString(), payload })
}

function emitThreadMessage(bus: EventBus, threadKey: string, threadLabel: string, text: string) {
  emitBusEvent(bus, 'ad4m.thread.message', { threadKey, threadLabel, text })
}

// ── Persistence ────────────────────────────────────────────────────────────────

interface PersistedWatch {
  uuid: string
  threadKey: string
  label: string
}
interface PersistedFile {
  watched: PersistedWatch[]
  /** Per-perspective seen message source addresses — survives restarts to avoid re-firing. */
  seenMessages: Record<string, string[]>
}

function loadPersisted(watchedFile: string): PersistedFile {
  try {
    const raw = fs.readFileSync(watchedFile, 'utf-8')
    const data = JSON.parse(raw) as PersistedFile
    return {
      watched: data.watched ?? [],
      seenMessages: data.seenMessages ?? {}
    }
  } catch {
    return { watched: [], seenMessages: {} }
  }
}

function savePersisted(watchedFile: string, watched: PersistedWatch[], seenMessages: Record<string, string[]>): void {
  try {
    fs.mkdirSync(path.dirname(watchedFile), { recursive: true })
    fs.writeFileSync(watchedFile, JSON.stringify({ watched, seenMessages }, null, 2))
  } catch (e) {
    console.warn('[ad4m] waker: failed to persist state:', e)
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function startWaker(
  clientManager: Ad4mClientManager,
  bus: EventBus,
  /** Path to JSON file for persisting watches and seen-message state. */
  watchedFile?: string,
  /**
   * Display name of the AI agent (e.g. "Hex"). When set, this is used as the
   * primary mention search term instead of (or in addition to) names from the
   * AD4M profile — because people invoke the AI by this name, not the human's.
   */
  configuredAgentName?: string
): WatcherController {
  // User-configured watches (persisted across restarts)
  const userWatches = new Map<string, WatchEntry>()
  // Auto-discovered watches (from perspective.all() on each connect)
  const autoWatches = new Map<string, WatchEntry>()
  // UUIDs subscribed in the current client session — reset when client changes
  const subscribedInSession = new Set<string>()
  // Live SPARQL subscription proxies — keyed by perspective UUID
  const proxies = new Map<string, InstanceType<typeof QuerySubscriptionProxy>>()
  // Per-perspective seen message SOURCE addresses (message node, not body link)
  const seenMessages = new Map<string, Set<string>>()
  // Debounce timers per perspective (2 s)
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let lastClient: Ad4mTypedClient | null = null
  let agentIdentity: AgentIdentity | null = null

  // Load persisted state
  let persistedSeenMessages: Record<string, string[]> = {}
  if (watchedFile) {
    const persisted = loadPersisted(watchedFile)
    for (const e of persisted.watched) {
      userWatches.set(e.uuid, {
        uuid: e.uuid,
        threadKey: e.threadKey,
        label: e.label,
        autoDiscovered: false
      })
    }
    persistedSeenMessages = persisted.seenMessages
  }

  function persistState() {
    if (!watchedFile) return
    const watchArr = [...userWatches.values()].map((e) => ({
      uuid: e.uuid,
      threadKey: e.threadKey,
      label: e.label
    }))
    const seenObj: Record<string, string[]> = {}
    for (const [uuid, set] of seenMessages) {
      seenObj[uuid] = [...set]
    }
    savePersisted(watchedFile, watchArr, seenObj)
  }

  function disposeProxy(uuid: string) {
    const proxy = proxies.get(uuid)
    if (proxy) {
      try {
        proxy.dispose()
      } catch {
        /* ignore */
      }
      proxies.delete(uuid)
    }
    const timer = debounceTimers.get(uuid)
    if (timer) {
      clearTimeout(timer)
      debounceTimers.delete(uuid)
    }
  }

  /**
   * Subscribe to @mention events for a perspective using a SPARQL live query.
   *
   * Only fires when a new message body contains the agent's DID or profile name(s)
   * as a substring — no spam from all neighbourhood activity.
   *
   * Deduplicates by message SOURCE address (the message node), not the body link.
   * Persists seen addresses so reconnects don't re-fire old mentions.
   *
   * First result from the subscription is treated as baseline (seeds seen set
   * without emitting) if there is no persisted state for this perspective.
   */
  function subscribeToMentions(client: Ad4mTypedClient, uuid: string, identity: AgentIdentity) {
    if (subscribedInSession.has(uuid)) return
    subscribedInSession.add(uuid)

    const query = buildMentionQuery(identity)
    const proxy = new QuerySubscriptionProxy(uuid, query, client.perspective)
    ;(proxy as any).isSPARQL = true
    ;(proxy as any).initialized?.catch?.(() => {})

    proxy
      .subscribe()
      .then(() => (proxy as any).initialized)
      .catch((err: unknown) => {
        const msg = (err as Error)?.message ?? String(err)
        console.warn(`[ad4m] waker: mention subscription failed for ${uuid}:`, msg)
        subscribedInSession.delete(uuid)
        proxies.delete(uuid)
      })

    // Seed seen set from persisted state — avoids re-firing after restart
    const seen = new Set<string>(persistedSeenMessages[uuid] ?? [])
    seenMessages.set(uuid, seen)
    if (seen.size > 0) {
      console.log(`[ad4m] waker: seeded ${seen.size} seen message(s) for ${uuid}`)
    }

    // True when no persisted data exists — first result is treated as baseline
    const isFirstRun = !persistedSeenMessages[uuid] || persistedSeenMessages[uuid].length === 0
    let isBaseline = isFirstRun

    proxy.onResult(async (result: unknown) => {
      if (!Array.isArray(result)) return

      if (isBaseline) {
        isBaseline = false
        // Seed all current matches as seen without emitting — prevents flood on first start
        let count = 0
        for (const item of result) {
          const source: string = (item as any)?.source ?? ''
          if (source && !seen.has(source)) {
            seen.add(source)
            count++
          }
        }
        console.log(`[ad4m] waker: baseline seeded for ${uuid} (${count} existing mentions)`)
        persistState()
        return
      }

      const entry = userWatches.get(uuid) ?? autoWatches.get(uuid)
      if (!entry) return

      // Find message nodes we haven't seen before
      const newMsgAddrs: string[] = []
      for (const item of result) {
        const source: string = (item as any)?.source ?? ''
        if (source && !seen.has(source)) {
          newMsgAddrs.push(source)
          seen.add(source) // mark immediately to prevent duplicates across rapid results
        }
      }

      if (newMsgAddrs.length === 0) return

      // Debounce: coalesce rapid mentions into a single wake (2 s window)
      const existing = debounceTimers.get(uuid)
      if (existing) clearTimeout(existing)

      debounceTimers.set(
        uuid,
        setTimeout(async () => {
          debounceTimers.delete(uuid)

          for (const msgAddr of newMsgAddrs) {
            const body = await resolveChildBody(client, uuid, msgAddr)
            const parents = await resolveParents(client, uuid, msgAddr)

            const parentPart =
              parents.length > 0 ? ` (in ${parents.map((p) => p.split('/').pop() ?? p.slice(0, 12)).join(', ')})` : ''

            const authorShort = msgAddr.split('/').pop() ?? msgAddr.slice(0, 12)
            const text = body
              ? `[AD4M] @${authorShort} mentioned you${parentPart}: "${body}"`
              : `[AD4M] @${authorShort} mentioned you${parentPart}`

            emitBusEvent(bus, 'ad4m.perspective.mention', { uuid, msgAddr, parents, body })
            emitThreadMessage(bus, entry.threadKey, entry.label, text)
          }

          persistState()
        }, 2000)
      )
    })

    proxies.set(uuid, proxy)
    console.log(
      `[ad4m] waker: mention subscription active for ${uuid}` + ` (terms: [${identity.names.join(', ')}] + DID)`
    )
  }

  // Called on every connect/reconnect. Resolves agent identity, re-subscribes all watches,
  // and auto-discovers neighbourhood perspectives.
  async function onConnected() {
    const client = clientManager.getClient()
    if (!client) return

    // Detect client instance change (after setToken) — reset subscription tracking
    if (client !== lastClient) {
      subscribedInSession.clear()
      for (const [uuid] of proxies) disposeProxy(uuid)
      lastClient = client
      agentIdentity = null // re-resolve identity with new client
    }

    // Resolve agent identity — required to build the mention query
    if (!agentIdentity) {
      // Skip profile name extraction when configuredAgentName is set — avoids
      // any risk of unparsed literal:json: blobs entering the SPARQL query.
      agentIdentity = await resolveAgentIdentity(client, !!configuredAgentName)
      if (!agentIdentity) {
        console.warn('[ad4m] waker: could not resolve agent identity — subscriptions skipped')
        return
      }
      if (configuredAgentName) {
        agentIdentity = { did: agentIdentity.did, names: [configuredAgentName] }
      }
      console.log(
        `[ad4m] waker: agent identity resolved — DID ...${agentIdentity.did.slice(-12)},` +
          ` names: [${agentIdentity.names.join(', ') || 'none'}]`
      )
    }

    const identity = agentIdentity

    // Re-subscribe all user-configured watches
    for (const entry of userWatches.values()) {
      subscribeToMentions(client, entry.uuid, identity)
    }

    // Auto-discover: mention-watch all joined neighbourhood perspectives
    try {
      const perspectives = await client.perspective.all()
      for (const p of perspectives) {
        if (!p.sharedUrl) continue
        if (userWatches.has(p.uuid)) continue // user config takes precedence

        if (!autoWatches.has(p.uuid)) {
          autoWatches.set(p.uuid, {
            uuid: p.uuid,
            threadKey: `ad4m/perspective/${p.uuid}`,
            label: `AD4M Perspective ${p.uuid.slice(0, 8)}`,
            autoDiscovered: true
          })
        }
        subscribeToMentions(client, p.uuid, identity)
      }
    } catch (e) {
      console.warn('[ad4m] waker: auto-discover failed:', (e as Error)?.message)
    }
  }

  // ── Static subscriptions (agent status, DMs, notifications) ──────────────────
  function wireStaticListeners(client: Ad4mTypedClient) {
    client.agent.addAgentStatusChangedListener((agentStatus) => {
      emitBusEvent(bus, 'ad4m.agent.status_changed', { agent: agentStatus })
    })

    client.agent.addUpdatedListener((agent) => {
      emitBusEvent(bus, 'ad4m.agent.updated', { agent })
    })

    client.agent.addAppChangedListener(() => {
      emitBusEvent(bus, 'ad4m.apps.changed', {})
    })

    // SDK callback types declare `null` return; cast to avoid void/null mismatch
    client.runtime.addMessageCallback(((msg: unknown) => {
      const senderDid = (msg as Record<string, unknown>)?.['author'] ?? 'unknown'
      emitBusEvent(bus, 'ad4m.dm.received', { message: msg, senderDid })
    }) as any)

    client.runtime.addNotificationTriggeredCallback(((notification: unknown) => {
      emitBusEvent(bus, 'ad4m.notification.triggered', { notification })
    }) as any)
  }

  // Wire static listeners on the current client
  const initialClient = clientManager.getClient()
  if (initialClient) {
    wireStaticListeners(initialClient)
    lastClient = initialClient
  }

  // Hook reconnect — also fires static listener re-wiring on new client instances
  clientManager.onConnected(() => {
    const client = clientManager.getClient()
    if (!client) return
    if (client !== lastClient) {
      wireStaticListeners(client)
    }
    onConnected().catch((e) => console.warn('[ad4m] waker: onConnected error:', e))
  })

  // Kick off initial auto-discover (client may already be connected)
  onConnected().catch(() => {
    /* will retry on next onConnected */
  })

  // ── WatcherController ─────────────────────────────────────────────────────────
  return {
    watchPerspective(uuid, threadKey, label) {
      const entry: WatchEntry = {
        uuid,
        threadKey,
        label: label ?? `AD4M: ${threadKey}`,
        autoDiscovered: false
      }
      userWatches.set(uuid, entry)
      autoWatches.delete(uuid)
      persistState()

      const client = clientManager.getClient()
      if (client && agentIdentity) {
        // Force re-subscribe: dispose existing proxy and clear session tracking
        disposeProxy(uuid)
        subscribedInSession.delete(uuid)
        subscribeToMentions(client, uuid, agentIdentity)
      }
      console.log(`[ad4m] waker: watching perspective ${uuid} → thread "${threadKey}"`)
    },

    unwatchPerspective(uuid) {
      userWatches.delete(uuid)
      autoWatches.delete(uuid)
      disposeProxy(uuid)
      subscribedInSession.delete(uuid)
      seenMessages.delete(uuid)
      persistState()
      console.log(`[ad4m] waker: unwatched perspective ${uuid}`)
    },

    getWatched() {
      return [...userWatches.values(), ...autoWatches.values()]
    }
  }
}
