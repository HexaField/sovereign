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
      'chat.queue.update',
      'backend.status'
    ],
    clientMessages: [
      'chat.send',
      'chat.abort',
      'chat.history',
      'chat.history.full',
      'chat.session.switch',
      'chat.session.create',
      'chat.cancel'
    ],
    onMessage: (type: string, payload: unknown, deviceId: string) => {
      const msg = payload as Record<string, unknown>
      const threadKey = msg.threadKey as string

      switch (type) {
        case 'chat.send':
          chatModule.handleSend(threadKey, msg.text as string, msg.attachments as Buffer[] | undefined)
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
        case 'chat.cancel':
          chatModule.handleCancel(msg.id as string)
          break
      }
    }
  })
}
