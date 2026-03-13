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

/** Calculate textarea height based on content */
export function calculateHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT)
}

/** Manage input history: add entry, maintain limit */
export function addToHistory(history: string[], message: string, limit: number = HISTORY_LIMIT): string[] {
  const updated = [...history, message]
  return updated.slice(-limit)
}

/** Navigate history: returns the entry at given index, or empty string */
export function getHistoryEntry(history: string[], index: number): string {
  if (index < 0 || index >= history.length) return ''
  return history[index]
}

/** Save scratchpad to storage (pure function taking a storage-like object) */
export function saveScratchpad(
  storage: { setItem: (key: string, value: string) => void },
  threadKey: string,
  value: string
): void {
  storage.setItem(getScratchpadKey(threadKey), value)
}

/** Restore scratchpad from storage */
export function restoreScratchpad(storage: { getItem: (key: string) => string | null }, threadKey: string): string {
  return storage.getItem(getScratchpadKey(threadKey)) ?? ''
}

/** Clear scratchpad from storage */
export function clearScratchpad(storage: { removeItem: (key: string) => void }, threadKey: string): void {
  storage.removeItem(getScratchpadKey(threadKey))
}

/** Save history to storage */
export function saveHistory(
  storage: { setItem: (key: string, value: string) => void },
  threadKey: string,
  history: string[]
): void {
  storage.setItem(getHistoryKey(threadKey), JSON.stringify(history))
}

/** Load history from storage */
export function loadHistory(storage: { getItem: (key: string) => string | null }, threadKey: string): string[] {
  const raw = storage.getItem(getHistoryKey(threadKey))
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

/** Validate file for attachment */
export function validateFile(file: File, maxSizeMB: number = 10): { valid: boolean; error?: string } {
  const maxSize = maxSizeMB * 1024 * 1024
  if (file.size > maxSize) {
    return { valid: false, error: `File exceeds ${maxSizeMB}MB limit` }
  }
  return { valid: true }
}

/** Check if send should be enabled */
export function canSend(text: string, attachments: File[]): boolean {
  return text.trim().length > 0 || attachments.length > 0
}

/** Determine if agent is busy (working/thinking) */
export function isAgentBusy(status: AgentStatus): boolean {
  return status === 'working' || status === 'thinking'
}

/** Get status display text */
export function getStatusText(status: AgentStatus): string | null {
  if (status === 'working') return 'Working…'
  if (status === 'thinking') return 'Thinking…'
  return null
}

export function InputArea(props: InputAreaProps) {
  let textareaRef: HTMLTextAreaElement | undefined
  let currentText = ''

  const handleSend = () => {
    const text = currentText.trim()
    if (!text) return
    props.onSend(text)
    currentText = ''
    if (textareaRef) {
      textareaRef.value = ''
      textareaRef.style.height = `${INPUT_MIN_HEIGHT}px`
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement
    currentText = target.value
    // Auto-resize
    target.style.height = 'auto'
    target.style.height = `${calculateHeight(target.scrollHeight)}px`
  }

  const statusText = getStatusText(props.agentStatus)
  const busy = isAgentBusy(props.agentStatus)

  return (
    <div
      class="border-t"
      style={{
        background: 'var(--c-bg)',
        'border-color': 'var(--c-border)'
      }}
    >
      {/* Status indicator */}
      {statusText && (
        <div class="px-3 pt-1 text-xs" style={{ color: 'var(--c-text-muted)' }}>
          {statusText}
        </div>
      )}

      <div
        class="flex items-end gap-2 p-3"
        style={{
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
          ref={textareaRef}
          class="flex-1 resize-none rounded-lg px-3 py-2 text-sm outline-none"
          style={{
            background: 'var(--c-input-bg)',
            color: 'var(--c-text)',
            'min-height': `${INPUT_MIN_HEIGHT}px`,
            'max-height': `${INPUT_MAX_HEIGHT}px`
          }}
          rows={1}
          placeholder="Message..."
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          disabled={props.disabled}
        />

        {/* Send / Abort button */}
        {busy ? (
          <button
            onClick={() => props.onAbort()}
            class="rounded-lg p-2"
            style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
          >
            ⬛
          </button>
        ) : (
          <button
            onClick={handleSend}
            class="rounded-lg p-2"
            style={{ background: 'var(--c-accent)', color: 'var(--c-bg)' }}
          >
            ➤
          </button>
        )}
      </div>
    </div>
  )
}
