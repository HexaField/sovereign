// Routing layer for the multi-backend seam. Owns one or more concrete
// `AgentBackend` instances and dispatches calls by session key. The chat
// module, threads routes, system routes — anything that previously held a
// single backend reference — now holds a `RoutingBackend` instead.
//
// In Phase 0 only the OpenClaw backend is wired up. Pi / Claude Code drop in
// later via the same factory.

import type { AgentBackend, AgentBackendEvents, AgentBackendKind, BackendConnectionStatus } from '@sovereign/core'
import type { SessionsRegistry, ThreadSessionRecord } from '@sovereign/primitives'

export interface BackendInstance {
  kind: AgentBackendKind
  backend: AgentBackend
}

/** Per-backend config bundle accepted by `createBackend`. */
export interface MultiBackendConfig {
  /** Backends enabled in this process. Order matters only for tie-breaking. */
  enabled: AgentBackendKind[]
  /** Default backend used for new sessions. Must be in `enabled`. */
  default: AgentBackendKind
  /** Factories for the enabled backends. Only called for backends actually enabled. */
  factories: Partial<Record<AgentBackendKind, () => AgentBackend>>
  /** Sovereign-owned thread→backend registry. */
  registry: SessionsRegistry
}

export interface RoutingBackend {
  /** All enabled backend instances. */
  all(): BackendInstance[]
  /** Backend chosen for a brand-new session (no registry entry yet). */
  default(): AgentBackend
  /** Backend that owns this session, resolved via the sessions registry. */
  forSession(sessionKey: string): AgentBackend
  /** Backend instance for a kind (or undefined if disabled). */
  forKind(kind: AgentBackendKind): AgentBackend | undefined
  /** Connect all enabled backends. */
  connectAll(): Promise<void>
  /** Disconnect all enabled backends. */
  disconnectAll(): Promise<void>
  /** Per-backend connection status, keyed by kind. */
  statusAll(): Record<AgentBackendKind, BackendConnectionStatus | 'disabled'>
  /** Register an event handler that fires for events from ANY enabled backend. */
  on<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  off<K extends keyof AgentBackendEvents>(event: K, handler: (data: AgentBackendEvents[K]) => void): void
  /** Record a thread→session→backend binding so `forSession` resolves later. */
  bindThread(record: Omit<ThreadSessionRecord, 'createdAt' | 'updatedAt'>): ThreadSessionRecord
  /** Look up a thread/session record. */
  lookup(sessionKey: string): ThreadSessionRecord | undefined
  /** Direct registry access for modules that need to enumerate. */
  registry: SessionsRegistry
}

const ALL_KINDS: AgentBackendKind[] = ['openclaw', 'pi', 'claude-code']

export function createBackend(config: MultiBackendConfig): RoutingBackend {
  if (!config.enabled.includes(config.default)) {
    throw new Error(`SOVEREIGN_DEFAULT_BACKEND=${config.default} is not in SOVEREIGN_ENABLED_BACKENDS`)
  }

  const instances = new Map<AgentBackendKind, BackendInstance>()
  for (const kind of config.enabled) {
    const factory = config.factories[kind]
    if (!factory) throw new Error(`Backend ${kind} is enabled but no factory was supplied`)
    instances.set(kind, { kind, backend: factory() })
  }

  /** Resolve a sessionKey to the owning backend.
   *
   * Strategy:
   *   1) Registry lookup — explicit bindings always win.
   *   2) Configured default — `SOVEREIGN_DEFAULT_BACKEND` is the user's
   *      authoritative choice for unbound `agent:*` keys.
   *   3) Legacy OpenClaw shortcut — historically `agent:main:*` keys were
   *      OpenClaw-exclusive and many existing threads have no registry
   *      record. Only honour this when OpenClaw is enabled AND nothing
   *      above resolved, so flipping the default to claude-code actually
   *      reroutes those threads instead of silently sticking on OpenClaw.
   */
  function resolveBackend(sessionKey: string): AgentBackend {
    const record = config.registry.getBySession(sessionKey) ?? config.registry.getByThread(sessionKey)
    if (record) {
      const inst = instances.get(record.backendKind)
      if (inst) return inst.backend
    }
    // Configured default wins for unbound keys regardless of prefix shape.
    const def = instances.get(config.default)
    if (def) return def.backend
    // Last-resort legacy fallback: an `agent:*` key with no registry record
    // and no enabled default backend lands on OpenClaw if it's enabled.
    if (sessionKey.startsWith('agent:')) {
      const oc = instances.get('openclaw')
      if (oc) return oc.backend
    }
    return defaultBackend()
  }

  function defaultBackend(): AgentBackend {
    return instances.get(config.default)!.backend
  }

  // Re-emit events from every backend through a single hub so consumers can
  // subscribe once. Each backend's emitter already stamps `backendKind`.
  const handlers = new Map<string, Set<(data: any) => void>>()

  function subscribeBackend(inst: BackendInstance, event: string) {
    inst.backend.on(
      event as any,
      ((data: any) => {
        const set = handlers.get(event)
        if (set) set.forEach((fn) => fn(data))
      }) as any
    )
  }

  // For each event we expose, ensure we forward from every backend. We do
  // this lazily on first `on()` per event so we don't subscribe to events no
  // one cares about.
  const subscribedEvents = new Set<string>()
  function ensureSubscribed(event: string) {
    if (subscribedEvents.has(event)) return
    subscribedEvents.add(event)
    for (const inst of instances.values()) subscribeBackend(inst, event)
  }

  const routing: RoutingBackend = {
    registry: config.registry,
    all() {
      return [...instances.values()]
    },
    default: defaultBackend,
    forSession: resolveBackend,
    forKind(kind) {
      return instances.get(kind)?.backend
    },
    async connectAll() {
      await Promise.all([...instances.values()].map((i) => i.backend.connect().catch(() => {})))
    },
    async disconnectAll() {
      await Promise.all([...instances.values()].map((i) => i.backend.disconnect().catch(() => {})))
    },
    statusAll() {
      const out = {} as Record<AgentBackendKind, BackendConnectionStatus | 'disabled'>
      for (const kind of ALL_KINDS) {
        out[kind] = instances.has(kind) ? instances.get(kind)!.backend.status() : 'disabled'
      }
      return out
    },
    on(event, handler) {
      if (!handlers.has(event as string)) handlers.set(event as string, new Set())
      handlers.get(event as string)!.add(handler as any)
      ensureSubscribed(event as string)
    },
    off(event, handler) {
      handlers.get(event as string)?.delete(handler as any)
    },
    bindThread(record) {
      return config.registry.upsert(record)
    },
    lookup(sessionKey) {
      return config.registry.getBySession(sessionKey) ?? config.registry.getByThread(sessionKey)
    }
  }

  return routing
}
