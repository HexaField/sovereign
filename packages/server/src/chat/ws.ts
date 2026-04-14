// Chat Module — WS channel registration + message handlers

import type { WsHandler } from '../ws/handler.js'
import type { ChatModule } from './chat.js'

export function registerChatWs(wsHandler: WsHandler, chatModule: ChatModule): void {
  wsHandler.registerChannel('chat', {
    serverMessages: [
      'chat.stream',
      'chat.turn',
      'chat.status',
      'chat.work',
      'chat.compacting',
      'chat.error',
      'chat.session.info',
      'backend.status'
    ],
    clientMessages: [
      'chat.send',
      'chat.abort',
      'chat.history',
      'chat.history.full',
      'chat.session.switch',
      'chat.session.create'
    ],
    onMessage: (type: string, payload: unknown, deviceId: string) => {
      const msg = payload as Record<string, unknown>
      const threadKey = msg.threadKey as string

      const ackId = msg.ackId as string | undefined

      switch (type) {
        case 'chat.send':
          chatModule
            .handleSend(threadKey, msg.text as string, msg.attachments as Buffer[] | undefined)
            .then(() => {
              if (ackId && wsHandler.sendTo) {
                wsHandler.sendTo(deviceId, { type: 'ack', ackId, status: 'accepted' } as any)
              }
            })
            .catch((err: unknown) => {
              if (ackId && wsHandler.sendTo) {
                const errMsg = err instanceof Error ? err.message : String(err)
                wsHandler.sendTo(deviceId, { type: 'nack', ackId, error: errMsg } as any)
              }
            })
          break
        case 'chat.abort':
          chatModule.handleAbort(threadKey)
          break
        case 'chat.history':
          chatModule.handleHistory(threadKey, deviceId)
          break
        case 'chat.history.full':
          chatModule.handleFullHistory(threadKey, deviceId)
          break
        case 'chat.session.switch':
          chatModule.handleSessionSwitch(threadKey)
          break
        case 'chat.session.create':
          chatModule.handleSessionCreate(msg.label as string | undefined)
          break
      }
    }
  })
}
