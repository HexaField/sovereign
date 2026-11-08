// Forge registry — one adapter per (forge, host), built on first use.
// Today only GitHub has an adapter; a remote on another forge resolves to
// undefined so callers can skip it.

import type { Forge, ForgeKind } from '@sovereign/core'
import type { ForgeRemote, HostForges } from '@sovereign/orgs'
import { createGithubForge, type GithubForgeOpts } from './github.js'

export type ForgeFactory = (host: string) => Forge

export interface ForgeRegistryOpts {
  /** Self-hosted hosts → forge (github.com is always GitHub). */
  hosts?: HostForges
  /** Options for every GitHub adapter (token, apiUrl, page size…). */
  github?: GithubForgeOpts
  /** Per-host GitHub options, e.g. an Enterprise host's apiUrl and token. */
  githubHosts?: Record<string, GithubForgeOpts>
  /** Adapters for other forges, by kind. */
  factories?: Partial<Record<ForgeKind, ForgeFactory>>
}

export interface ForgeRegistry {
  /** The adapter for a remote, a ForgeRef-like `{ forge, host }`, or a host name. */
  forgeFor(target: string | Pick<ForgeRemote, 'forge' | 'host'>): Forge | undefined
  /** Which forge a host runs, if known. */
  kindOf(host: string): ForgeKind | undefined
  /** Use this adapter for its (kind, host) — tests and later forges. */
  register(forge: Forge): void
}

export function createForgeRegistry(opts: ForgeRegistryOpts = {}): ForgeRegistry {
  const hosts: HostForges = { 'github.com': 'github' }
  for (const [h, k] of Object.entries(opts.hosts ?? {})) hosts[h.toLowerCase()] = k
  const forges = new Map<string, Forge>()
  const key = (kind: ForgeKind, host: string) => `${kind}:${host.toLowerCase()}`

  function build(kind: ForgeKind, host: string): Forge | undefined {
    if (kind === 'github') {
      const per = opts.githubHosts?.[host]
      if (host !== 'github.com' && !per?.apiUrl) {
        // Enterprise: REST at https://<host>/api/v3 unless configured otherwise.
        return createGithubForge({ ...opts.github, ...per, apiUrl: `https://${host}/api/v3`, host })
      }
      return createGithubForge({ ...opts.github, ...per, host })
    }
    const factory = opts.factories?.[kind]
    return factory ? factory(host) : undefined
  }

  const registry: ForgeRegistry = {
    kindOf(host) {
      return hosts[host.toLowerCase()]
    },

    forgeFor(target) {
      const host = (typeof target === 'string' ? target : target.host).toLowerCase()
      const kind = typeof target === 'string' ? hosts[host] : target.forge
      if (!kind) return undefined
      const k = key(kind, host)
      let f = forges.get(k)
      if (!f) {
        f = build(kind, host)
        if (f) forges.set(k, f)
      }
      return f
    },

    register(forge) {
      forges.set(key(forge.kind, forge.host), forge)
      hosts[forge.host.toLowerCase()] ??= forge.kind
    }
  }
  return registry
}
