// Chat Module — WS proxy, session mapping, bus integration

import type { EventBus, AgentBackend } from '@template/core'

export interface ThreadManager {
  // Placeholder for the thread manager interface
  getThreads(): unknown[]
}

export interface ChatModule {
  status(): { module: string; status: string }
}

export function createChatModule(_bus: EventBus, _backend: AgentBackend, _threadManager: ThreadManager): ChatModule {
  throw new Error('not implemented')
}
