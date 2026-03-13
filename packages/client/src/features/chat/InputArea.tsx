import type { AgentStatus } from '@template/core'

export interface InputAreaProps {
  onSend: (text: string, attachments?: File[]) => void
  onAbort: () => void
  agentStatus: AgentStatus
  threadKey: string
  disabled?: boolean
}

export const INPUT_MIN_HEIGHT = 40
export const INPUT_MAX_HEIGHT = 200
export const HISTORY_LIMIT = 50
export const SCRATCHPAD_DEBOUNCE_MS = 500

export function getHistoryKey(threadKey: string): string {
  return `sovereign:history:${threadKey}`
}

export function getScratchpadKey(threadKey: string): string {
  return `sovereign:scratchpad:${threadKey}`
}

export function InputArea(props: InputAreaProps) {
  return (
    <div
      class="flex items-end gap-2 border-t p-3"
      style={{
        background: 'var(--c-bg)',
        'border-color': 'var(--c-border)',
        'padding-bottom': 'calc(0.75rem + env(safe-area-inset-bottom, 0px))'
      }}
    >
      {/* File attach button */}
      <button class="rounded-lg p-2" style={{ color: 'var(--c-text-muted)' }}>
        📎
      </button>

      {/* Voice record button */}
      <button class="rounded-lg p-2" style={{ color: 'var(--c-text-muted)' }}>
        🎤
      </button>

      {/* Textarea */}
      <textarea
        class="flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none"
        style={{
          background: 'var(--c-input-bg)',
          color: 'var(--c-text)',
          'min-height': `${INPUT_MIN_HEIGHT}px`,
          'max-height': `${INPUT_MAX_HEIGHT}px`
        }}
        rows={1}
        placeholder="Message..."
      />

      {/* Send / Abort button */}
      {props.agentStatus === 'working' || props.agentStatus === 'thinking' ? (
        <button
          onClick={() => props.onAbort()}
          class="rounded-lg p-2"
          style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
        >
          ⬛
        </button>
      ) : (
        <button class="rounded-lg p-2" style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}>
          ➤
        </button>
      )}
    </div>
  )
}
