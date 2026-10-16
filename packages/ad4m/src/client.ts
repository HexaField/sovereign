// AD4M typed client — thin manager wrapper around @coasys/ad4m's Ad4mClient.
//
// ── AD4M API surface overview ──────────────────────────────────────────────────
//
// AD4M exposes two distinct network APIs. Do not conflate them:
//
//   1. MCP (http://localhost:3001/mcp) — JSON-RPC 2.0 over Streamable HTTP.
//      Used by Claude Code sessions for mcp__ad4m__* tools. Injected at session
//      start via packages/agent-backend/src/claude-code/env-config.ts.
//      Auth: Bearer JWT or --admin-credential at executor startup.
//
//   2. TypeScript SDK (http://localhost:12000) — what this file wraps.
//      The @coasys/ad4m Ad4mClient handles the WS-based transport internally.
//      Used here for server-side subscriptions, queries, and agent management.
//      Auth: JWT passed via setToken(), or admin credential on connect.
//
// There is also a low-level WS RPC interface (ws://localhost:12000/api/v1/ws)
// used internally by the SDK's ApiClient. Do NOT bypass the SDK to use it
// directly — always go through Ad4mClient.
//
// ──────────────────────────────────────────────────────────────────────────────

import { Ad4mClient } from '@coasys/ad4m'
import { readToken } from './auth.js'

/** The SDK's Ad4mClient — sub-clients at .agent, .perspective, .runtime, etc. */
export type Ad4mTypedClient = Ad4mClient

export interface Ad4mClientManager {
  getClient(): Ad4mTypedClient | null
  isConnected(): boolean
  setToken(token: string): void
  close(): void
  /** Register a callback fired whenever the client transitions to connected —
   *  on initial connect and on every reconnect (including after setToken).
   *  Returns an unsubscriber. */
  onConnected(cb: () => void): () => void
}

// ── Manager ───────────────────────────────────────────────────────────────────

export function createAd4mClientManager(opts: {
  host: string // http(s):// or ws(s):// URL — normalized to http internally
  tokenFile: string
  /** Health check period. Default 15 s. */
  healthIntervalMs?: number
  /** A health check that has not answered by then counts as failed. Default 10 s. */
  statusTimeoutMs?: number
  /** SDK client factory (tests). */
  createClient?: (host: string, token?: string) => Ad4mClient
}): Ad4mClientManager {
  const healthIntervalMs = opts.healthIntervalMs ?? 15_000
  const statusTimeoutMs = opts.statusTimeoutMs ?? 10_000
  const makeClient = opts.createClient ?? ((host: string, token?: string) => new Ad4mClient(host, token))
  let sdkClient: Ad4mClient | null = null
  let token: string | undefined
  let connected = false
  let closed = false
  let checking = false
  let everChecked = false
  let healthTimer: ReturnType<typeof setInterval> | null = null
  let firstTimer: ReturnType<typeof setTimeout> | null = null
  const connectedCbs = new Set<() => void>()

  function normalizeHost(h: string): string {
    return h.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
  }

  function fireConnected() {
    for (const cb of connectedCbs) {
      try {
        cb()
      } catch (e) {
        console.warn('[ad4m] onConnected callback error:', e)
      }
    }
  }

  /** Probe the executor. A failed or unanswered probe replaces the SDK client:
   *  once the executor has been unreachable, the SDK's websocket can stay
   *  wedged (calls await a readiness promise that never settles), so the old
   *  client would never see the executor come back. Consumers pick up the new
   *  instance through onConnected, as after setToken. */
  async function check() {
    const client = sdkClient
    if (!client || closed || checking) return
    checking = true
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        client.agent.status(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${statusTimeoutMs} ms`)), statusTimeoutMs)
        })
      ])
      if (client !== sdkClient || closed) return
      if (!connected) {
        connected = true
        console.log('[ad4m] connected to', opts.host)
        fireConnected()
      }
    } catch (e) {
      if (client !== sdkClient || closed) return
      if (connected) console.warn('[ad4m] health check failed — disconnected:', (e as Error)?.message)
      else if (!everChecked) console.warn('[ad4m] initial connect failed:', (e as Error)?.message)
      connected = false
      try {
        client.close()
      } catch {
        /* already closed */
      }
      sdkClient = makeClient(normalizeHost(opts.host), token)
    } finally {
      clearTimeout(timer)
      everChecked = true
      checking = false
    }
  }

  function connect(newToken?: string) {
    if (closed) return
    token = newToken
    everChecked = false
    sdkClient = makeClient(normalizeHost(opts.host), token)
    healthTimer = setInterval(() => void check(), healthIntervalMs)
    firstTimer = setTimeout(() => void check(), 1000)
  }

  connect(readToken(opts.tokenFile) ?? undefined)

  return {
    getClient: () => sdkClient,
    isConnected: () => connected,
    onConnected(cb: () => void) {
      connectedCbs.add(cb)
      // If already connected, fire immediately
      if (connected) {
        try {
          cb()
        } catch {}
      }
      return () => connectedCbs.delete(cb)
    },
    setToken(newToken: string) {
      if (healthTimer) clearInterval(healthTimer)
      if (firstTimer) clearTimeout(firstTimer)
      sdkClient?.close()
      sdkClient = null
      connected = false
      checking = false
      connect(newToken)
    },
    close() {
      closed = true
      connected = false
      if (healthTimer) clearInterval(healthTimer)
      if (firstTimer) clearTimeout(firstTimer)
      sdkClient?.close()
      sdkClient = null
    }
  }
}
