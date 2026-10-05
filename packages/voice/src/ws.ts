// Voice streaming — WebSocket channel registration.
//
// Registers a `voice-stream` channel on the WS handler for real-time
// speech-to-text. The client sends audio chunks as base64 strings;
// the server accumulates and periodically transcribes via the batch
// whisper-stt HTTP endpoint, returning partial transcripts.
//
// Protocol:
//   Client → Server:
//     voice-stream.start  { format?: 'webm' | 'pcm16', sampleRate?: number, deliver?: 'presence' }
//     voice-stream.chunk  { audio: string }   (base64: webm, or raw 16-bit mono PCM)
//     voice-stream.stop   {}
//
//   Server → Client:
//     voice-stream.transcript  { text: string, final: boolean }   (to the streaming connection)
//     voice-stream.error       { message: string }
//     voice-stream.draft       { source, threadId, text, done }   (deliver: 'presence' only)
//
// deliver: 'presence' serves a client with no screen of its own (the voice
// node's push-to-talk). The live text goes as a draft to every connection
// sharing the streamer's device name, shown in the presence thread, and on
// stop the server sends the final text to the presence thread itself.

import type { WsChannelOptions } from '@sovereign/core'
import { createStreamingManager } from './streaming.js'

/** Minimal WsHandler surface needed by the voice-stream channel. Avoids
 *  a hard dependency on @sovereign/primitives. */
interface WsHandlerLike {
  registerChannel(name: string, options: WsChannelOptions): void
  sendTo(deviceId: string, msg: Record<string, unknown>): void
  sendToDeviceName(name: string, msg: Record<string, unknown>): void
  getDeviceName(deviceId: string): string | undefined
}

export interface VoiceStreamChannelDeps {
  ws: WsHandlerLike
  /** URL of the whisper-stt /transcribe endpoint (e.g. http://127.0.0.1:9876/transcribe). */
  transcribeUrl: string
  /** The presence thread, and how to send a voice message to it (deliver: 'presence'). */
  presence?: {
    threadId(): string | undefined
    send(text: string, opts: { deviceId: string; deviceName?: string }): Promise<{ delivered: boolean }>
  }
}

/** Where a presence-delivering stream's draft shows. */
interface Target {
  deviceName: string
  threadId: string
}

interface StartPayload {
  format?: string
  sampleRate?: number
  deliver?: string
}

export function registerVoiceStreamChannel(deps: VoiceStreamChannelDeps): void {
  const { ws, transcribeUrl, presence } = deps
  const manager = createStreamingManager()
  // The current presence-delivering stream per device.
  const delivering = new Map<string, Target>()
  // Per device, the last stop's send: messages land in the order spoken.
  const sends = new Map<string, Promise<void>>()

  // Drafts come only from the device's current stream: a stopped stream's
  // late text or `done` would otherwise overwrite the next stream's draft.
  const draft = (source: string, target: Target | undefined, text: string, done: boolean): void => {
    if (!target || delivering.get(source) !== target) return
    ws.sendToDeviceName(target.deviceName, {
      type: 'voice-stream.draft',
      source,
      threadId: target.threadId,
      text,
      done
    })
  }

  ws.registerChannel('voice-stream', {
    serverMessages: ['voice-stream.transcript', 'voice-stream.error', 'voice-stream.draft'],
    clientMessages: ['voice-stream.start', 'voice-stream.chunk', 'voice-stream.stop'],
    onMessage(type, payload, deviceId) {
      if (type === 'voice-stream.start') {
        const start = (payload ?? {}) as StartPayload
        const deviceName = ws.getDeviceName(deviceId)
        const threadId = presence?.threadId()
        const target = start.deliver === 'presence' && deviceName && threadId ? { deviceName, threadId } : undefined
        if (target) delivering.set(deviceId, target)
        else {
          draft(deviceId, delivering.get(deviceId), '', true)
          delivering.delete(deviceId)
        }
        manager.startSession(deviceId, {
          transcribeUrl,
          format: start.format === 'pcm16' ? 'pcm16' : 'webm',
          sampleRate: start.sampleRate,
          onTranscript(text, isFinal) {
            ws.sendTo(deviceId, {
              type: 'voice-stream.transcript',
              text,
              final: isFinal
            })
            if (!isFinal) draft(deviceId, target, text, false)
          },
          onError(err) {
            ws.sendTo(deviceId, {
              type: 'voice-stream.error',
              message: err.message
            })
          }
        })
        draft(deviceId, target, '', false)
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
        const target = delivering.get(deviceId)
        const final = manager.stopSession(deviceId)
        const sent = (sends.get(deviceId) ?? Promise.resolve())
          .then(() => final)
          .then(async (text) => {
            if (!target || !presence) return
            // Send first, then clear the draft: the message replaces it without a gap.
            if (text.trim()) {
              await presence
                .send(text, { deviceId, deviceName: target.deviceName })
                .catch((err: Error) => console.warn('[voice-stream] presence send failed:', err.message))
            }
            draft(deviceId, target, '', true)
            if (delivering.get(deviceId) === target) delivering.delete(deviceId)
          })
        sends.set(deviceId, sent)
        void sent.finally(() => {
          if (sends.get(deviceId) === sent) sends.delete(deviceId)
        })
        return
      }
    },

    onDisconnect(deviceId) {
      // Clean up if client disconnects mid-stream
      manager.abortSession(deviceId)
      draft(deviceId, delivering.get(deviceId), '', true)
      delivering.delete(deviceId)
    }
  })
}
