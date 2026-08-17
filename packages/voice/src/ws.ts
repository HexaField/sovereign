// Voice streaming — WebSocket channel registration.
//
// Registers a `voice-stream` channel on the WS handler for real-time
// speech-to-text. The client sends audio chunks as base64 strings;
// the server accumulates and periodically transcribes via the batch
// whisper-stt HTTP endpoint, returning partial transcripts.
//
// Protocol:
//   Client → Server:
//     voice-stream.start  {}
//     voice-stream.chunk  { audio: string }   (base64-encoded webm)
//     voice-stream.stop   {}
//
//   Server → Client:
//     voice-stream.transcript  { text: string, final: boolean }
//     voice-stream.error       { message: string }

import type { WsChannelOptions } from '@sovereign/core'
import { createStreamingManager } from './streaming.js'

/** Minimal WsHandler surface needed by the voice-stream channel. Avoids
 *  a hard dependency on @sovereign/primitives. */
interface WsHandlerLike {
  registerChannel(name: string, options: WsChannelOptions): void
  sendTo(deviceId: string, msg: Record<string, unknown>): void
}

export interface VoiceStreamChannelDeps {
  ws: WsHandlerLike
  /** URL of the whisper-stt /transcribe endpoint (e.g. http://127.0.0.1:9876/transcribe). */
  transcribeUrl: string
}

export function registerVoiceStreamChannel(deps: VoiceStreamChannelDeps): void {
  const { ws, transcribeUrl } = deps
  const manager = createStreamingManager()

  ws.registerChannel('voice-stream', {
    serverMessages: ['voice-stream.transcript', 'voice-stream.error'],
    clientMessages: ['voice-stream.start', 'voice-stream.chunk', 'voice-stream.stop'],
    onMessage(type, payload, deviceId) {
      if (type === 'voice-stream.start') {
        manager.startSession(deviceId, {
          transcribeUrl,
          onTranscript(text, isFinal) {
            ws.sendTo(deviceId, {
              type: 'voice-stream.transcript',
              text,
              final: isFinal
            })
          },
          onError(err) {
            ws.sendTo(deviceId, {
              type: 'voice-stream.error',
              message: err.message
            })
          }
        })
        return
      }

      if (type === 'voice-stream.chunk') {
        const msg = payload as { audio?: string }
        const session = manager.getSession(deviceId)
        if (session && msg.audio) {
          session.pushChunk(msg.audio)
        }
        return
      }

      if (type === 'voice-stream.stop') {
        void manager.stopSession(deviceId)
        return
      }
    },

    onDisconnect(deviceId) {
      // Clean up if client disconnects mid-stream
      manager.abortSession(deviceId)
    }
  })
}
