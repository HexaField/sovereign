// The message being dictated, shown as an outlined user bubble with a live
// recording dot. It grows with the text, so the chat area — up to the whole
// screen — holds the transcript. Tap it to pause the mic and edit in place.

import { Show, createEffect } from 'solid-js'
import { voiceDraftActions, type VoiceDraft } from './voice-draft-store.js'

export function VoiceDraftBubble(props: { draft: VoiceDraft }) {
  let editor: HTMLTextAreaElement | undefined

  const fit = () => {
    if (!editor) return
    editor.style.height = 'auto'
    editor.style.height = `${editor.scrollHeight}px`
  }

  // Focus the editor when edit mode opens, cursor at the end. Several chat
  // views can be mounted at once (a hidden desktop panel behind the phone's
  // full-screen chat): only the visible one takes focus.
  createEffect(() => {
    if (!props.draft.editing) return
    queueMicrotask(() => {
      if (!editor || editor.offsetParent === null) return
      editor.focus()
      editor.setSelectionRange(editor.value.length, editor.value.length)
      fit()
    })
  })

  const listening = () => props.draft.state === 'streaming'

  return (
    <div class="flex w-full justify-end" data-testid="voice-draft">
      <div
        class="relative max-w-[85%] min-w-[40%] rounded-2xl rounded-br-sm px-4 pt-7 pb-3 text-sm leading-relaxed break-words whitespace-pre-wrap"
        classList={{ 'w-[85%]': props.draft.editing }}
        style={{
          background: 'transparent',
          border: '2px solid var(--c-user-bubble)',
          color: 'var(--c-text)'
        }}
      >
        {/* Recording indicator, top left */}
        <div
          class="absolute top-2 left-3 flex items-center gap-1.5 text-[11px]"
          style={{ color: 'var(--c-text-muted)' }}
        >
          <span
            class="inline-block h-2 w-2 rounded-full"
            classList={{ 'animate-pulse': listening() }}
            style={{ background: listening() ? 'var(--c-danger, #ef4444)' : 'var(--c-text-muted)' }}
          />
          {props.draft.readOnly
            ? 'Listening · push-to-talk'
            : props.draft.editing
              ? 'Editing · mic paused'
              : listening()
                ? 'Listening · tap to edit'
                : 'Paused · tap to edit'}
        </div>

        <Show
          when={props.draft.editing}
          fallback={
            <span
              class="block"
              classList={{ 'cursor-text': !props.draft.readOnly }}
              style={{
                color: props.draft.text.trim() ? 'var(--c-text)' : 'var(--c-text-muted)',
                'font-style': props.draft.text.trim() ? 'normal' : 'italic'
              }}
              onClick={() => !props.draft.readOnly && voiceDraftActions()?.edit()}
              title={props.draft.readOnly ? undefined : 'Tap to edit'}
            >
              {props.draft.text.trim() || (listening() ? 'Listening…' : 'Tap to edit')}
            </span>
          }
        >
          <textarea
            ref={editor}
            value={props.draft.text}
            rows={1}
            onInput={(e) => {
              voiceDraftActions()?.change(e.currentTarget.value)
              fit()
            }}
            onFocusOut={() => voiceDraftActions()?.done()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                voiceDraftActions()?.send()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.currentTarget.blur()
              }
            }}
            class="block w-full resize-none overflow-hidden border-none bg-transparent p-0 font-[inherit] text-sm leading-relaxed outline-none"
            style={{ color: 'var(--c-text)' }}
          />
        </Show>
      </div>
    </div>
  )
}
