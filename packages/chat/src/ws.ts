// Chat Module — WS channel registration + message handlers

import type { EventBus } from '@sovereign/core'
import type { WsHandler } from '@sovereign/primitives'
import type { ChatModule } from './chat.js'

export function registerChatWs(wsHandler: WsHandler, chatModule: ChatModule, bus?: EventBus): void {
  wsHandler.registerChannel('chat', {
    serverMessages: [
      'chat.stream',
      'chat.turn',
      'chat.status',
      'chat.work',
      'chat.compacting',
      'chat.error',
      'chat.session.info',
      'chat.queue',
      'backend.status',
      'cron.run.completed',
      // Subagent lifecycle — clients refetch /api/threads/active-subagents on
      // any of these so finished children don't pile up in the dropdown.
      'subagent.spawned',
      'subagent.completed',
      'subagent.failed',
      // AskUserQuestion lifecycle — drives the inline question card. `pending`
      // fires when the SDK invokes the tool and the store registers it;
      // `answered` when the user submits (or `aborted` on cancel/error).
      'question.pending',
      'question.answered',
      'question.aborted',
      // TTS override — broadcast state changes so all clients see the toggle
      'voice.tts-override.state'
    ],
    clientMessages: [
      'chat.send',
      'chat.abort',
      'chat.history',
      'chat.history.full',
      'chat.session.switch',
      'chat.session.create',
      'voice.tts-override'
    ],
    onMessage: (type: string, payload: unknown, deviceId: string) => {
      const msg = payload as Record<string, unknown>
      const threadKey = msg.threadKey as string

      const ackId = msg.ackId as string | undefined

      switch (type) {
        case 'chat.send':
          chatModule
            .handleSend(
              threadKey,
              msg.text as string,
              msg.attachments as import('@sovereign/core').Attachment[] | undefined
            )
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
        case 'voice.tts-override':
          if (bus) {
            // Resolve the device name from the WS connection that sent the
            // toggle — the device identity travels with the action.
            const dName = wsHandler.getDeviceName(deviceId)
            bus.emit({
              type: 'voice.tts-override',
              timestamp: new Date().toISOString(),
              source: 'ws',
              payload: {
                threadId: msg.threadId,
                enabled: msg.enabled,
                deviceName: dName || msg.deviceName || null
              }
            })
          }
          break
      }
    }
  })
}
