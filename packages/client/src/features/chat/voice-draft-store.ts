// The message being dictated — shown in the thread as an outlined user
// bubble while speech-to-text streams, so the whole chat area is room to
// read and edit it. InputArea owns the recording and publishes the draft;
// ChatView renders it (VoiceDraftBubble) and routes edits back.

import { createSignal } from 'solid-js'

export interface VoiceDraft {
  /** The thread the draft is for; other threads never show it. */
  threadKey: string
  text: string
  /** 'streaming' while the mic listens, 'paused' while the user edits or pauses. */
  state: 'streaming' | 'paused'
  editing: boolean
  /** Dictated elsewhere (a voice node's push-to-talk): shown live, not editable here. */
  readOnly?: boolean
}

/** What the bubble may ask the input area to do. */
export interface VoiceDraftActions {
  /** Tap on the text: pause the mic and edit. */
  edit(): void
  change(text: string): void
  /** Edit finished (blur or Escape): resume the mic. */
  done(): void
  send(): void
}

const [draft, setDraft] = createSignal<VoiceDraft | null>(null)
let actions: VoiceDraftActions | null = null

/** The draft to show in `threadKey`, or null. */
export function voiceDraftFor(threadKey: string): VoiceDraft | null {
  const d = draft()
  return d && d.threadKey === threadKey ? d : null
}

export function voiceDraftActions(): VoiceDraftActions | null {
  return actions
}

export function publishVoiceDraft(next: VoiceDraft, owner: VoiceDraftActions): void {
  actions = owner
  setDraft(next)
}

/** Clear the draft, unless another publisher has taken over since. */
export function clearVoiceDraft(owner: VoiceDraftActions): void {
  if (actions !== owner) return
  actions = null
  setDraft(null)
}
