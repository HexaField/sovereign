import { describe, it, expect, vi } from 'vitest'
import { initRemoteDictation } from './remote-dictation.js'
import {
  voiceDraftFor,
  voiceDraftActions,
  publishVoiceDraft,
  clearVoiceDraft,
  type VoiceDraftActions
} from '../chat/voice-draft-store.js'
import type { WsStore } from '../../ws/ws-store.js'

function fakeWs() {
  const handlers = new Map<string, Set<(msg: any) => void>>()
  const ws = {
    on: (type: string, handler: (msg: any) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
      return () => handlers.get(type)?.delete(handler)
    }
  } as unknown as WsStore
  const fire = (type: string, msg: Record<string, unknown> = {}) => {
    for (const h of handlers.get(type) ?? []) h({ type, ...msg })
  }
  return { ws, fire }
}

const draft = (text: string, done = false, source = 'node') =>
  ({ source, threadId: 'presence', text, done }) as Record<string, unknown>

describe('remote dictation', () => {
  it('shows a voice node’s live text as a read-only draft in the presence thread until the stream ends', () => {
    const { ws, fire } = fakeWs()
    const cleanup = initRemoteDictation(ws)

    fire('voice-stream.draft', draft(''))
    expect(voiceDraftFor('presence')).toMatchObject({ text: '', state: 'streaming', readOnly: true })
    fire('voice-stream.draft', draft('turn on the'))
    fire('voice-stream.draft', draft('turn on the lights'))
    expect(voiceDraftFor('presence')?.text).toBe('turn on the lights')
    expect(voiceDraftFor('other')).toBeNull()

    fire('voice-stream.draft', draft('', true))
    expect(voiceDraftFor('presence')).toBeNull()
    cleanup()
  })

  it('never replaces or clears dictation in this tab, and clears its own draft on reconnect', () => {
    const { ws, fire } = fakeWs()
    const cleanup = initRemoteDictation(ws)
    fire('voice-stream.draft', draft('from the node'))

    const local: VoiceDraftActions = { edit: vi.fn(), change: vi.fn(), done: vi.fn(), send: vi.fn() }
    publishVoiceDraft({ threadKey: 'presence', text: 'typed here', state: 'streaming', editing: false }, local)
    fire('voice-stream.draft', draft('from the node, later'))
    expect(voiceDraftFor('presence')?.text).toBe('typed here')
    expect(voiceDraftActions()).toBe(local)
    fire('voice-stream.draft', draft('', true))
    expect(voiceDraftFor('presence')?.text).toBe('typed here')

    clearVoiceDraft(local)
    fire('voice-stream.draft', draft('again'))
    expect(voiceDraftFor('presence')?.text).toBe('again')
    fire('ws.reconnected')
    expect(voiceDraftFor('presence')).toBeNull()
    cleanup()
  })
})
