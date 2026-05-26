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
}): Ad4mClientManager {
  let sdkClient: Ad4mClient | null = null
  let connected = false
  let closed = false
  let healthTimer: ReturnType<typeof setInterval> | null = null
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

  function connect(token?: string) {
    if (closed) return
    sdkClient = new Ad4mClient(normalizeHost(opts.host), token)

    healthTimer = setInterval(async () => {
      if (!sdkClient || closed) return
      try {
        await sdkClient.agent.status()
        if (!connected) {
          connected = true
          console.log('[ad4m] connected to', opts.host)
          fireConnected()
        }
      } catch {
        if (connected) console.warn('[ad4m] health check failed — disconnected')
        connected = false
      }
    }, 15_000)

    setTimeout(async () => {
      if (!sdkClient || closed) return
      try {
        await sdkClient.agent.status()
        if (!connected) {
          connected = true
          console.log('[ad4m] connected to', opts.host)
          fireConnected()
        }
      } catch (e) {
        console.warn('[ad4m] initial connect failed:', (e as Error)?.message)
        connected = false
      }
    }, 1000)
  }

  const token = readToken(opts.tokenFile)
  connect(token ?? undefined)

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
    setToken(token: string) {
      if (healthTimer) clearInterval(healthTimer)
      sdkClient?.close()
      sdkClient = null
      connected = false
      connect(token)
    },
    close() {
      closed = true
      connected = false
      if (healthTimer) clearInterval(healthTimer)
      sdkClient?.close()
      sdkClient = null
    }
  }
}
