// Dictation from a voice node's push-to-talk. The node has no screen: it
// streams speech to the server, which sends the live text to the tabs that
// share the node's device name (voice-stream.draft). The text shows as the
// dictation draft bubble in the presence thread, read-only — the server
// sends the message itself when the keys lift, then clears the draft.

import type { WsStore } from '../../ws/ws-store.js'
import { clearVoiceDraft, publishVoiceDraft, type VoiceDraftActions } from '../chat/voice-draft-store.js'

interface DraftMessage {
  source: string
  threadId: string
  text: string
  done: boolean
}

const readOnly = (): VoiceDraftActions => ({ edit() {}, change() {}, done() {}, send() {} })

export function initRemoteDictation(ws: WsStore): () => void {
  // One owner per streaming device, so one stream's end never clears another's draft.
  const owners = new Map<string, VoiceDraftActions>()
  const clearAll = () => {
    for (const owner of owners.values()) clearVoiceDraft(owner)
    owners.clear()
  }

  const unsubDraft = ws.on('voice-stream.draft', (raw) => {
    const msg = raw as unknown as DraftMessage
    if (msg.done) {
      const owner = owners.get(msg.source)
      if (owner) clearVoiceDraft(owner)
      owners.delete(msg.source)
      return
    }
    const owner = owners.get(msg.source) ?? readOnly()
    owners.set(msg.source, owner)
    publishVoiceDraft(
      { threadKey: msg.threadId, text: msg.text, state: 'streaming', editing: false, readOnly: true },
      owner
    )
  })
  // A reconnect may have missed the stream's end: drop what it left behind.
  const unsubReconnect = ws.on('ws.reconnected', clearAll)

  return () => {
    unsubDraft()
    unsubReconnect()
    clearAll()
  }
}
