// Status aggregator + WebSocket connection handler wiring. Combines the
// module status reporters and pushes updates onto every WS client.

import type { EventBus } from '@sovereign/core'
import type { WebSocketServer } from 'ws'
import { createStatusAggregator, type StatusAggregator } from './status.js'
import type { WsHandler } from '@sovereign/primitives'
import type { ChatModule } from '@sovereign/chat'
import type { VoiceModule } from '@sovereign/voice'
import type { ConfigStore } from '@sovereign/config'

interface RadicleStatusProvider {
  status(): { name: string; status: 'ok' | 'degraded' | 'error' }
}
import type { PlanningService } from '@sovereign/planning'
import type { SystemModule } from '@sovereign/system'

export interface StatusWiringInput {
  bus: EventBus
  wss: WebSocketServer
  wsHandler: WsHandler
  chatModule: ChatModule
  voiceModule: VoiceModule
  radicleManager: RadicleStatusProvider
  configStore: ConfigStore
  planningService: PlanningService
  systemModule: SystemModule
}

export function wireStatusAggregator(input: StatusWiringInput): StatusAggregator {
  const { bus, wss, wsHandler, chatModule, voiceModule, radicleManager, configStore, planningService, systemModule } =
    input

  const statusAggregator = createStatusAggregator(bus, {
    modules: [
      { name: 'chat', status: () => chatModule.status() },
      {
        name: 'voice',
        status: () => ({ name: voiceModule.status().module, status: voiceModule.status().status as any })
      },
      { name: 'radicle', status: () => radicleManager.status() },
      { name: 'config', status: () => configStore.status() },
      {
        name: 'planning',
        status: () => ({ name: 'planning', status: planningService.status().status as any })
      },
      {
        name: 'system',
        status: () => ({ name: 'system', status: systemModule.status().healthy ? 'ok' : 'degraded' })
      }
    ],
    pushToClients: (update) => {
      const msg = JSON.stringify(update)
      for (const client of wss.clients) if (client.readyState === 1) client.send(msg)
    }
  })

  wss.on('connection', (ws) => {
    const deviceId = Math.random().toString(36).slice(2)
    wsHandler.handleConnection(ws as any, deviceId)
    ws.send(JSON.stringify({ type: 'status.update', payload: statusAggregator.getStatus() }))
  })

  return statusAggregator
}
