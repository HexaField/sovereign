import path from 'node:path'
import type { EventBus } from '@sovereign/core'
import type { Application as Express } from 'express'
import { createAd4mClientManager, type Ad4mClientManager } from './client.js'
import { startWaker, type WatcherController, type WatchEntry } from './waker.js'
import { startNotificationBridge } from './notifications.js'
import { createAd4mRoutes } from './routes.js'

export interface Ad4mConfig {
  /** http(s):// URL of the AD4M executor's main API (WS-RPC) */
  host: string
  /** Absolute path to the token JSON file */
  tokenFile: string
  /** Route incoming DMs to per-sender Sovereign threads. */
  routeDmThreads?: boolean
  /** Route agent system events to a Sovereign thread. */
  routeSystemThread?: boolean
  /**
   * Display name of the AI agent (e.g. "Hex"). Used as the primary mention
   * search term in the waker — people type this name to invoke the agent.
   * Falls back to the AD4M profile name if omitted.
   */
  agentName?: string
}

export interface Ad4mService {
  client(): Ad4mClientManager
  isConnected(): boolean
  router(): ReturnType<typeof createAd4mRoutes>
  mountRoutes(app: Express): void
  /** Dynamically watch a perspective — routes new mentions to the given thread. */
  watchPerspective(uuid: string, threadKey: string, label?: string): void
  /** Stop watching a perspective. */
  unwatchPerspective(uuid: string): void
  /** List all currently watched perspectives (user-configured + auto-discovered). */
  getWatchedPerspectives(): WatchEntry[]
  close(): void
}

export function createAd4mService(
  config: Ad4mConfig,
  bus: EventBus,
  notifications?: import('@sovereign/notifications').Notifications
): Ad4mService {
  const clientManager = createAd4mClientManager({ host: config.host, tokenFile: config.tokenFile })

  // Watched-perspectives store lives next to the token file
  const watchedFile = path.join(path.dirname(config.tokenFile), 'ad4m-watched.json')
  const watcher: WatcherController = startWaker(clientManager, bus, watchedFile, config.agentName)

  const stopNotificationBridge = notifications ? startNotificationBridge(bus, notifications) : () => {}

  const _router = createAd4mRoutes(clientManager, config.tokenFile, watcher)

  return {
    client: () => clientManager,
    isConnected: () => clientManager.isConnected(),
    router: () => _router,
    mountRoutes: (app) => app.use(_router),
    watchPerspective: (uuid, threadKey, label) => watcher.watchPerspective(uuid, threadKey, label),
    unwatchPerspective: (uuid) => watcher.unwatchPerspective(uuid),
    getWatchedPerspectives: () => watcher.getWatched(),
    close: () => {
      stopNotificationBridge()
      clientManager.close()
    }
  }
}
