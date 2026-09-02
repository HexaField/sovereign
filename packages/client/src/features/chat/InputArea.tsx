import { createSignal, createEffect, Show, For, onCleanup } from 'solid-js'
import type { AgentStatus } from '@sovereign/core'
import { AttachIcon, CloseIcon, LoaderIcon } from '../../ui/icons.js'
import {
  inputValue,
  setInputValue,
  agentStatus as storeAgentStatus,
  sendMessage,
  abortChat,
  compacting,
  retryCountdownSeconds
} from './store.js'
import { threadKey } from '../threads/store.js'
import type { SlashCommand } from './slash-commands.js'
import { isSlashQuery, filterCommands, buildCommandText, moveIndex } from './slash-commands.js'
import { SlashCommandPicker } from './SlashCommandPicker.js'
import { isRecording, setVoiceState, voiceTimerText, setVoiceTimerText } from '../voice/store.js'
import {
  streamingState,
  startStreaming,
  pauseStreaming,
  stopStreaming,
  initStreaming,
  hasActiveSession
} from '../voice/streaming.js'
import { deviceName } from '../settings/device-name.js'

// ── Constants (exported for tests) ───────────────────────────────────

export const INPUT_MIN_HEIGHT = 40
export const INPUT_MAX_HEIGHT = 200
export const HISTORY_LIMIT = 50
export const SCRATCHPAD_DEBOUNCE_MS = 500

// ── Pure utility functions (exported for tests) ─────────────────────

export function getHistoryKey(threadKey: string): string {
  return `sovereign:history:${threadKey}`
}

export function getScratchpadKey(threadKey: string): string {
  return `sovereign:scratchpad:${threadKey}`
}

export function calculateHeight(scrollHeight: number): number {
  return Math.min(Math.max(scrollHeight, INPUT_MIN_HEIGHT), INPUT_MAX_HEIGHT)
}

export function addToHistory(history: string[], message: string, limit: number = HISTORY_LIMIT): string[] {
  const updated = [...history, message]
  return updated.slice(-limit)
}

export function getHistoryEntry(history: string[], index: number): string {
  if (index < 0 || index >= history.length) return ''
  return history[index]
}

export function saveScratchpad(
  storage: { setItem: (key: string, value: string) => void },
  threadKey: string,
  value: string
): void {
  storage.setItem(getScratchpadKey(threadKey), value)
}

export function restoreScratchpad(storage: { getItem: (key: string) => string | null }, threadKey: string): string {
  return storage.getItem(getScratchpadKey(threadKey)) ?? ''
}

export function clearScratchpad(storage: { removeItem: (key: string) => void }, threadKey: string): void {
  storage.removeItem(getScratchpadKey(threadKey))
}

export function saveHistory(
  storage: { setItem: (key: string, value: string) => void },
  threadKey: string,
  history: string[]
): void {
  storage.setItem(getHistoryKey(threadKey), JSON.stringify(history))
}

export function loadHistory(storage: { getItem: (key: string) => string | null }, threadKey: string): string[] {
  const raw = storage.getItem(getHistoryKey(threadKey))
  if (!raw) return []
  try {
    return JSON.parse(raw)
  } catch {
    return []
  }
}

export function validateFile(file: File, maxSizeMB: number = 10): { valid: boolean; error?: string } {
  const maxSize = maxSizeMB * 1024 * 1024
  if (file.size > maxSize) {
    return { valid: false, error: `File exceeds ${maxSizeMB}MB limit` }
  }
  return { valid: true }
}

export function canSend(text: string, attachments: File[]): boolean {
  return text.trim().length > 0 || attachments.length > 0
}

export function isAgentBusy(status: AgentStatus): boolean {
  return status === 'working' || status === 'thinking'
}

export function getStatusText(status: AgentStatus): string | null {
  if (status === 'working') return 'Working…'
  if (status === 'thinking') return 'Thinking…'
  return null
}

// ── localStorage history helpers (internal) ─────────────────────────

function loadMsgHistory(sk: string): string[] {
  return loadHistory(localStorage, sk)
}

function pushMsgHistory(sk: string, text: string): void {
  const history = loadMsgHistory(sk)
  if (history[history.length - 1] !== text) {
    history.push(text)
  }
  saveHistory(localStorage, sk, history.slice(-HISTORY_LIMIT))
}

// ── Scratchpad persistence ───────────────────────────────────────────

interface ScratchpadEntry {
  id: number
  text: string
  ts: number
}

function scratchpadStorageKey(sk: string): string {
  return `sovereign:scratchpad-entries:${sk}`
}

function loadScratchpadEntries(sk: string): ScratchpadEntry[] {
  try {
    return JSON.parse(localStorage.getItem(scratchpadStorageKey(sk)) || '[]')
  } catch {
    return []
  }
}

function saveScratchpadEntries(sk: string, entries: ScratchpadEntry[]): void {
  if (entries.length === 0) {
    localStorage.removeItem(scratchpadStorageKey(sk))
  } else {
    localStorage.setItem(scratchpadStorageKey(sk), JSON.stringify(entries))
  }
}

// ── Component ────────────────────────────────────────────────────────

export interface InputAreaProps {
  onSend?: (text: string, attachments?: File[]) => void
  onAbort?: () => void
  agentStatus?: AgentStatus
  threadKey?: string
  disabled?: boolean
}

export function InputArea(props: InputAreaProps) {
  let textareaRef!: HTMLTextAreaElement

  const [scratchpad, setScratchpad] = createSignal<ScratchpadEntry[]>(loadScratchpadEntries(threadKey()))
  const [scratchpadOpen, setScratchpadOpen] = createSignal(false)
  const [editingId, setEditingId] = createSignal<number | null>(null)

  // File attachment state
  const [attachedFiles, setAttachedFiles] = createSignal<{ name: string; path: string; size: number; file: File }[]>([])
  const [isDragging, setIsDragging] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  let dragCounter = 0

  const [textFocused, setTextFocused] = createSignal(false)
  let editRef: HTMLTextAreaElement | undefined

  // Message history navigation state
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  let draftText = ''

  const navigateHistory = (direction: 'up' | 'down') => {
    const history = loadMsgHistory(threadKey())
    if (history.length === 0) return
    if (direction === 'up') {
      if (historyIndex() === -1) {
        draftText = inputValue()
        setHistoryIndex(history.length - 1)
      } else if (historyIndex() > 0) {
        setHistoryIndex(historyIndex() - 1)
      } else {
        return
      }
      setInputValue(history[historyIndex()])
    } else {
      if (historyIndex() === -1) return
      if (historyIndex() < history.length - 1) {
        setHistoryIndex(historyIndex() + 1)
        setInputValue(history[historyIndex()])
      } else {
        setHistoryIndex(-1)
        setInputValue(draftText)
      }
    }
    autoResize()
    setTimeout(() => {
      if (textareaRef) {
        const len = textareaRef.value.length
        textareaRef.setSelectionRange(len, len)
      }
    }, 0)
  }

  // Reload scratchpad when thread changes
  createEffect(() => {
    setScratchpad(loadScratchpadEntries(threadKey()))
    setScratchpadOpen(false)
  })

  const updateScratchpad = (entries: ScratchpadEntry[]) => {
    setScratchpad(entries)
    saveScratchpadEntries(threadKey(), entries)
  }

  const handleScratchpadButton = () => {
    const text = inputValue().trim()
    if (text) {
      const entry: ScratchpadEntry = { id: Date.now(), text, ts: Date.now() }
      updateScratchpad([...scratchpad(), entry])
      setInputValue('')
      if (textareaRef) textareaRef.style.height = 'auto'
    } else {
      setScratchpadOpen(!scratchpadOpen())
    }
  }

  const popEntry = (entry: ScratchpadEntry) => {
    setInputValue(entry.text)
    updateScratchpad(scratchpad().filter((e) => e.id !== entry.id))
    setScratchpadOpen(false)
    setTimeout(() => {
      if (textareaRef) {
        textareaRef.focus()
        textareaRef.style.height = 'auto'
        textareaRef.style.height = Math.min(textareaRef.scrollHeight, 120) + 'px'
      }
    }, 0)
  }

  const deleteEntry = (entry: ScratchpadEntry) => {
    updateScratchpad(scratchpad().filter((e) => e.id !== entry.id))
  }

  const startEdit = (entry: ScratchpadEntry) => {
    setEditingId(entry.id)
    setTimeout(() => {
      if (editRef) {
        editRef.focus()
        editRef.style.height = 'auto'
        editRef.style.height = Math.min(editRef.scrollHeight, 100) + 'px'
      }
    }, 0)
  }

  const commitEdit = (id: number, newText: string) => {
    const trimmed = newText.trim()
    if (trimmed) {
      updateScratchpad(scratchpad().map((e) => (e.id === id ? { ...e, text: trimmed } : e)))
    } else {
      updateScratchpad(scratchpad().filter((e) => e.id !== id))
    }
    setEditingId(null)
  }

  const autoResize = () => {
    if (!textareaRef) return
    if (textFocused() && isMobile) {
      textareaRef.style.height = ''
      return
    }
    textareaRef.style.height = 'auto'
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 120) + 'px'
  }

  const handleUploadFiles = async (files: FileList | File[]) => {
    setUploading(true)
    try {
      const fileArray = Array.from(files)
      const uploaded = fileArray.map((f) => ({
        name: f.name,
        path: URL.createObjectURL(f),
        size: f.size,
        file: f
      }))
      if (uploaded.length) {
        setAttachedFiles((prev) => [...prev, ...uploaded])
      }
    } catch (e) {
      console.error('File upload error:', e)
    } finally {
      setUploading(false)
    }
  }

  const removeAttachment = (idx: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault()
    dragCounter++
    if (e.dataTransfer?.types.includes('Files')) setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    dragCounter--
    if (dragCounter <= 0) {
      dragCounter = 0
      setIsDragging(false)
    }
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    dragCounter = 0
    setIsDragging(false)
    if (e.dataTransfer?.files.length) handleUploadFiles(e.dataTransfer.files)
  }

  // ── Slash-command picker ───────────────────────────────────────────────────
  const [slashCommandIndex, setSlashCommandIndex] = createSignal(-1)

  /** Currently filtered commands derived from the live input value. */
  const slashCommands = () => filterCommands(inputValue())

  /** True when the picker should be visible. */
  const slashPickerOpen = () => isSlashQuery(inputValue()) && slashCommands().length > 0

  // Reset keyboard selection when the picker closes or the command list changes.
  createEffect(() => {
    if (!slashPickerOpen()) setSlashCommandIndex(-1)
  })

  const handleSelectSlashCommand = (cmd: SlashCommand) => {
    setInputValue(buildCommandText(cmd))
    setSlashCommandIndex(-1)
    autoResize()
    // Return focus to the textarea so the user can type arguments immediately.
    setTimeout(() => textareaRef?.focus(), 0)
  }
  // ── AD4M slash command ─────────────────────────────────────────────────────
  const [commandStatus, setCommandStatus] = createSignal<{ ok: boolean; text: string } | null>(null)

  const handleAd4mCommand = async (raw: string) => {
    const parts = raw.trim().split(/\s+/)
    const action = parts[1]
    const url = parts[2]

    if (!action || !url || (action !== 'watch' && action !== 'unwatch')) {
      setCommandStatus({ ok: false, text: 'Usage: /ad4m watch|unwatch <neighbourhood://url>' })
      setTimeout(() => setCommandStatus(null), 5000)
      return
    }

    try {
      const res = await fetch('/api/ad4m/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, url, threadKey: threadKey() })
      })
      const data = (await res.json()) as { ok: boolean; message?: string; error?: string }
      setCommandStatus({ ok: data.ok, text: data.message ?? data.error ?? 'Done' })
    } catch (err) {
      setCommandStatus({ ok: false, text: `Command failed: ${(err as Error)?.message}` })
    }
    setTimeout(() => setCommandStatus(null), 5000)
  }
  // ────────────────────────────────────────────────────────────────────────────

  const handleSend = async () => {
    // Capture voice flag before stopping the session
    const usedVoice = voiceUsedForMessage()

    // Safety: stop any lingering streaming session
    if (hasActiveSession()) {
      stopStreaming()
      setVoiceState('idle')
      setVoiceTimerText('')
      setEditingTranscript(false)
    }

    const text = inputValue().trim()
    const files = attachedFiles()
    if (!text && !files.length) return

    // Intercept /ad4m slash commands — handled locally, not sent to agent
    if (text.startsWith('/ad4m ') || text === '/ad4m') {
      pushMsgHistory(threadKey(), text)
      setHistoryIndex(-1)
      draftText = ''
      setInputValue('')
      setVoiceUsedForMessage(false)
      clearScratchpad(localStorage, threadKey())
      if (textareaRef) textareaRef.style.height = 'auto'
      handleAd4mCommand(text)
      return
    }

    // Build message with file context for display
    let msg = text
    if (files.length) {
      const fileLines = files.map((f) => `📎 ${f.name} (${(f.size / 1024).toFixed(1)}KB)`).join('\n')
      msg = files.length && text ? `${text}\n\n${fileLines}` : fileLines
    }

    // Extract raw File objects for upload
    const rawFiles = files.map((f) => f.file)

    pushMsgHistory(threadKey(), text || '[files]')
    setHistoryIndex(-1)
    draftText = ''
    setInputValue('')
    setAttachedFiles([])
    setVoiceUsedForMessage(false)
    clearScratchpad(localStorage, threadKey())
    if (textareaRef) {
      textareaRef.style.height = 'auto'
    }

    // When voice was used during composition, attach voice origin metadata
    if (usedVoice) {
      const deviceId = (window as unknown as { __sovereignDeviceId?: string }).__sovereignDeviceId
      const name = deviceName()
      sendMessage(msg, rawFiles.length ? rawFiles : undefined, {
        origin: {
          modality: 'voice' as const,
          ...(deviceId ? { deviceId } : {}),
          ...(name ? { deviceName: name } : {})
        }
      })
    } else if (props.onSend) {
      props.onSend(msg, rawFiles.length ? rawFiles : undefined)
    } else {
      sendMessage(msg, rawFiles.length ? rawFiles : undefined)
    }
  }

  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  const handleKey = (e: KeyboardEvent) => {
    // Slash-command picker takes priority over all other keyboard handling.
    if (slashPickerOpen()) {
      const cmds = slashCommands()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashCommandIndex(moveIndex(slashCommandIndex(), 'down', cmds.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashCommandIndex(moveIndex(slashCommandIndex(), 'up', cmds.length))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const idx = slashCommandIndex()
        if (idx >= 0 && idx < cmds.length) {
          handleSelectSlashCommand(cmds[idx])
        } else if (cmds.length === 1) {
          // Auto-select when exactly one command matches.
          handleSelectSlashCommand(cmds[0])
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setInputValue('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      handleSend()
      return
    }

    // Arrow-key message history navigation
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const ta = e.currentTarget as HTMLTextAreaElement
      const cursorAtStart = ta.selectionStart === 0 && ta.selectionEnd === 0
      const cursorAtEnd = ta.selectionStart === ta.value.length
      const history = loadMsgHistory(threadKey())
      if (history.length === 0) return

      if (e.key === 'ArrowUp' && (cursorAtStart || !inputValue())) {
        e.preventDefault()
        navigateHistory('up')
      } else if (e.key === 'ArrowDown' && historyIndex() !== -1 && cursorAtEnd) {
        e.preventDefault()
        navigateHistory('down')
      }
    }
  }

  // ── Streaming STT ──────────────────────────────
  // Mic button toggles streaming transcription. The recording bar shows
  // streaming transcript text. Tapping the text enters edit mode (textarea
  // within the bar, mic pauses). Blur exits edit mode (mic resumes).
  // The regular send button auto-attaches voice origin when this flag
  // indicates voice was used during message composition.

  const [editingTranscript, setEditingTranscript] = createSignal(false)
  /** Tracks whether STT was used at any point during composition of the
   *  current message. Set when streaming starts, cleared on send/cancel. */
  const [voiceUsedForMessage, setVoiceUsedForMessage] = createSignal(false)
  let editTranscriptRef: HTMLTextAreaElement | undefined

  // Initialise streaming WS on first render
  {
    const mod = import('../../ws/index.js')
    void mod.then(({ wsStore }) => initStreaming(wsStore))
  }

  const toggleStreaming = async () => {
    const state = streamingState()
    if (state === 'streaming') {
      // Pause — stop mic, keep text for editing
      pauseStreaming()
      setVoiceState('idle')
      setVoiceTimerText('')
      return
    }

    if (state === 'paused') {
      // Resume — start mic again, append to existing text
      try {
        setVoiceState('listening')
        setEditingTranscript(false)
        setVoiceUsedForMessage(true)
        await startStreaming(
          inputValue(),
          (fullText) => setInputValue(fullText),
          (timerText) => setVoiceTimerText(timerText)
        )
      } catch {
        setVoiceState('idle')
      }
      return
    }

    // Start fresh
    try {
      setVoiceState('listening')
      setEditingTranscript(false)
      setVoiceUsedForMessage(true)
      await startStreaming(
        inputValue(),
        (fullText) => setInputValue(fullText),
        (timerText) => setVoiceTimerText(timerText)
      )
    } catch {
      setVoiceState('idle')
    }
  }

  /** Enter edit mode — pause mic, show textarea in recording bar. */
  const enterTranscriptEdit = () => {
    if (streamingState() === 'streaming') {
      pauseStreaming()
      setVoiceState('idle')
      setVoiceTimerText('')
    }
    setEditingTranscript(true)
    setTimeout(() => {
      if (editTranscriptRef) {
        editTranscriptRef.focus()
        const len = editTranscriptRef.value.length
        editTranscriptRef.setSelectionRange(len, len)
        editTranscriptRef.style.height = 'auto'
        editTranscriptRef.style.height = Math.min(editTranscriptRef.scrollHeight, 120) + 'px'
      }
    }, 0)
  }

  /** Exit edit mode — resume mic with current text. */
  const exitTranscriptEdit = async () => {
    setEditingTranscript(false)
    try {
      setVoiceState('listening')
      await startStreaming(
        inputValue(),
        (fullText) => setInputValue(fullText),
        (timerText) => setVoiceTimerText(timerText)
      )
    } catch {
      setVoiceState('idle')
    }
  }

  const cancelRecording = () => {
    stopStreaming()
    setVoiceState('idle')
    setVoiceTimerText('')
    setEditingTranscript(false)
    setVoiceUsedForMessage(false)
    setInputValue('')
  }

  const currentAgentStatus = () => props.agentStatus ?? storeAgentStatus()
  const busy = () => isAgentBusy(currentAgentStatus())

  const isBusyOrStreaming = () => busy()

  // ── Long-press send menu ──────────────────────────────────────────
  const [sendMenuOpen, setSendMenuOpen] = createSignal(false)
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let didLongPress = false

  const LONG_PRESS_MS = 400

  const startLongPress = () => {
    didLongPress = false
    longPressTimer = setTimeout(() => {
      didLongPress = true
      setSendMenuOpen(true)
    }, LONG_PRESS_MS)
  }

  const cancelLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
  }

  const handleSendPointerUp = () => {
    cancelLongPress()
    // Regular tap — only fire if long press didn't trigger
    if (!didLongPress) handleSend()
  }

  const handleSendImmediate = () => {
    setSendMenuOpen(false)
    const text = inputValue().trim()
    const files = attachedFiles()
    if (!text && !files.length) return

    let msg = text
    if (files.length) {
      const fileLines = files.map((f) => `📎 ${f.name} (${(f.size / 1024).toFixed(1)}KB)`).join('\n')
      msg = files.length && text ? `${text}\n\n${fileLines}` : fileLines
    }
    const rawFiles = files.map((f) => f.file)

    pushMsgHistory(threadKey(), text || '[files]')
    setHistoryIndex(-1)
    draftText = ''
    setInputValue('')
    setAttachedFiles([])
    clearScratchpad(localStorage, threadKey())
    if (textareaRef) textareaRef.style.height = 'auto'

    sendMessage(msg, rawFiles.length ? rawFiles : undefined, { immediate: true })
  }

  // Close menu on outside click
  const handleDocClick = (e: MouseEvent) => {
    if (sendMenuOpen()) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-send-menu]')) setSendMenuOpen(false)
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', handleDocClick, true)
    onCleanup(() => document.removeEventListener('click', handleDocClick, true))
  }
  // ──────────────────────────────────────────────────────────────────

  return (
    <div
      class="safe-bottom relative flex shrink-0 flex-col items-end gap-2.5 px-4 pt-3 pb-6"
      style={{ 'border-top': '1px solid var(--c-border)', background: 'var(--c-bg-raised)' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      <Show when={isDragging()}>
        <div
          class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-xl"
          style={{ background: 'rgba(99, 102, 241, 0.15)', border: '2px dashed var(--c-accent)' }}
        >
          <span class="text-sm font-medium" style={{ color: 'var(--c-accent)' }}>
            Drop files here
          </span>
        </div>
      </Show>

      {/* Retry countdown */}
      <Show when={retryCountdownSeconds() > 0}>
        <div class="flex w-full items-center gap-2 px-0.5">
          <div class="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: '#f59e0b' }} />
          <span class="text-xs" style={{ color: '#f59e0b' }}>
            Rate limited — retrying in {retryCountdownSeconds()}s
          </span>
        </div>
      </Show>

      {/* Compaction indicator */}
      <Show when={compacting()}>
        <div class="flex w-full items-center gap-2 px-0.5">
          <svg class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <span class="text-xs" style={{ color: '#8b5cf6' }}>
            Compacting context…
          </span>
        </div>
      </Show>

      {/* AD4M command feedback */}
      <Show when={commandStatus() !== null}>
        <div class="flex w-full items-center gap-2 px-0.5">
          <span
            class="text-xs"
            style={{ color: commandStatus()?.ok ? 'var(--c-success, #22c55e)' : 'var(--c-danger, #ef4444)' }}
          >
            {commandStatus()?.text}
          </span>
        </div>
      </Show>

      {/* Status indicator removed — header dot is sufficient */}

      {/* Attached files */}
      <Show when={attachedFiles().length > 0}>
        <div class="flex w-full flex-wrap gap-1.5 px-0.5">
          <For each={attachedFiles()}>
            {(file, idx) => (
              <div
                class="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px]"
                style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
              >
                <span>
                  <AttachIcon class="inline h-3 w-3" />
                </span>
                <span class="max-w-[150px] truncate" style={{ color: 'var(--c-text)' }}>
                  {file.name}
                </span>
                <span style={{ color: 'var(--c-text-muted)' }}>
                  {file.size < 1024
                    ? `${file.size}B`
                    : file.size < 1048576
                      ? `${(file.size / 1024).toFixed(0)}KB`
                      : `${(file.size / 1048576).toFixed(1)}MB`}
                </span>
                <button
                  class="ml-0.5 cursor-pointer text-[10px] leading-none hover:opacity-70"
                  style={{ color: 'var(--c-text-muted)' }}
                  onClick={() => removeAttachment(idx())}
                >
                  <CloseIcon class="inline h-3 w-3" />
                </button>
              </div>
            )}
          </For>
          <Show when={uploading()}>
            <div class="flex items-center gap-1 px-2.5 py-1 text-[11px]" style={{ color: 'var(--c-text-muted)' }}>
              <span class="animate-pulse">
                <LoaderIcon class="inline h-3 w-3 animate-spin" />
              </span>{' '}
              Uploading…
            </div>
          </Show>
        </div>
      </Show>

      {/* Input row */}
      <div
        class="flex w-full items-end gap-2.5"
        classList={{
          'max-sm:items-stretch max-sm:gap-2': textFocused()
        }}
      >
        {/* Slash-command picker — appears above input when first char is "/" */}
        <Show when={slashPickerOpen()}>
          <SlashCommandPicker
            commands={slashCommands()}
            selectedIndex={slashCommandIndex()}
            onSelect={handleSelectSlashCommand}
          />
        </Show>

        {/* Scratchpad popup */}
        <Show when={scratchpadOpen()}>
          <div
            class="absolute right-0 bottom-full left-0 z-50 mx-4 mb-1 overflow-hidden rounded-xl shadow-lg"
            style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
          >
            <div
              class="flex items-center justify-between px-4 py-2.5"
              style={{ 'border-bottom': '1px solid var(--c-border)' }}
            >
              <span class="text-xs font-medium tracking-wider uppercase" style={{ color: 'var(--c-text-muted)' }}>
                Scratchpad
              </span>
              <button
                class="cursor-pointer text-xs"
                style={{ color: 'var(--c-text-muted)' }}
                onClick={() => setScratchpadOpen(false)}
              >
                close
              </button>
            </div>
            <Show
              when={scratchpad().length > 0}
              fallback={
                <div class="px-4 py-6 text-center text-xs" style={{ color: 'var(--c-text-muted)' }}>
                  No saved messages
                </div>
              }
            >
              <div class="max-h-60 overflow-y-auto">
                <For each={scratchpad()}>
                  {(entry) => (
                    <div
                      class="group flex items-start gap-2 px-4 py-2.5 last:border-b-0"
                      style={{ 'border-bottom': '1px solid var(--c-border)' }}
                    >
                      <Show
                        when={editingId() === entry.id}
                        fallback={
                          <p
                            class="line-clamp-3 flex-1 cursor-pointer text-sm break-words whitespace-pre-wrap"
                            style={{ color: 'var(--c-text)' }}
                            onDblClick={() => startEdit(entry)}
                          >
                            {entry.text}
                          </p>
                        }
                      >
                        <textarea
                          ref={editRef}
                          class="flex-1 resize-none rounded-lg px-2.5 py-1.5 font-[inherit] text-sm outline-none"
                          style={{
                            background: 'var(--c-bg-raised)',
                            border: '1px solid var(--c-accent)',
                            color: 'var(--c-text)'
                          }}
                          value={entry.text}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              commitEdit(entry.id, e.currentTarget.value)
                            }
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          onFocusOut={(e) => commitEdit(entry.id, e.currentTarget.value)}
                        />
                      </Show>
                      <Show when={editingId() !== entry.id}>
                        <div class="flex shrink-0 items-center gap-1">
                          <button
                            class="cursor-pointer rounded-md px-2 py-1 text-xs transition-colors"
                            style={{
                              background: 'color-mix(in srgb, var(--c-accent) 15%, transparent)',
                              color: 'var(--c-accent)'
                            }}
                            onClick={() => popEntry(entry)}
                            title="Use this message"
                          >
                            pop
                          </button>
                          <button
                            class="cursor-pointer rounded-md px-1.5 py-1 text-xs transition-colors"
                            style={{ color: 'var(--c-text-muted)' }}
                            onClick={() => startEdit(entry)}
                            title="Edit"
                          >
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          </button>
                          <button
                            class="cursor-pointer rounded-md px-1.5 py-1 text-xs transition-colors"
                            style={{ color: 'var(--c-text-muted)' }}
                            onClick={() => deleteEntry(entry)}
                            title="Delete"
                          >
                            <CloseIcon class="inline h-3 w-3" />
                          </button>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        {/* Text input (hidden when recording) */}
        <Show when={!hasActiveSession()}>
          <div class="flex flex-1 items-end gap-1">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="Message..."
              value={inputValue()}
              onInput={(e) => {
                setInputValue(e.currentTarget.value)
                setSlashCommandIndex(-1)
                autoResize()
              }}
              onKeyDown={handleKey}
              onFocus={() => {
                setTextFocused(true)
                if (isMobile && textareaRef) textareaRef.style.height = ''
              }}
              onFocusOut={() => {
                setTextFocused(false)
                autoResize()
              }}
              class="max-h-[120px] flex-1 resize-none rounded-xl px-3.5 py-2.5 font-[inherit] text-sm transition-colors outline-none"
              style={{
                background: 'var(--c-bg)',
                border: '1px solid var(--c-border)',
                color: 'var(--c-text)',
                'min-height': `${INPUT_MIN_HEIGHT}px`
              }}
              classList={{
                'max-sm:max-h-none max-sm:h-full': textFocused()
              }}
              disabled={props.disabled}
            />
            {/* History navigation arrows (mobile) */}
            <div class="flex flex-col gap-0.5 md:hidden">
              <button
                class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
                style={{
                  color:
                    historyIndex() === -1 && loadMsgHistory(threadKey()).length > 0
                      ? 'var(--c-text-muted)'
                      : historyIndex() > 0
                        ? 'var(--c-text)'
                        : 'var(--c-text-muted)',
                  opacity:
                    loadMsgHistory(threadKey()).length === 0
                      ? '0.25'
                      : historyIndex() > 0 || historyIndex() === -1
                        ? '1'
                        : '0.4'
                }}
                onClick={() => navigateHistory('up')}
                title="Previous message"
                disabled={loadMsgHistory(threadKey()).length === 0}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
              <button
                class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded transition-colors"
                style={{
                  color: historyIndex() !== -1 ? 'var(--c-text)' : 'var(--c-text-muted)',
                  opacity: historyIndex() === -1 ? '0.25' : '1'
                }}
                onClick={() => navigateHistory('down')}
                title="Next message"
                disabled={historyIndex() === -1}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </div>
          </div>
        </Show>

        {/* Recording bar — replaces textarea during voice input */}
        <Show when={hasActiveSession()}>
          <div
            class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl px-3.5 py-2"
            style={{ background: 'var(--c-rec-bg, rgba(239,68,68,0.1))' }}
          >
            {/* Red dot + timer */}
            <Show when={streamingState() === 'streaming'}>
              <div
                class="h-2 w-2 shrink-0 animate-pulse rounded-full"
                style={{ background: 'var(--c-danger, #ef4444)' }}
              />
            </Show>
            <Show when={streamingState() === 'paused'}>
              <div class="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--c-text-muted)' }} />
            </Show>
            <span class="shrink-0 text-[13px] tabular-nums" style={{ color: 'var(--c-danger, #ef4444)' }}>
              {voiceTimerText() || '0:00'}
            </span>

            {/* Transcript display / edit toggle */}
            <Show
              when={!editingTranscript()}
              fallback={
                <textarea
                  ref={editTranscriptRef}
                  rows={1}
                  value={inputValue()}
                  onInput={(e) => setInputValue(e.currentTarget.value)}
                  onFocusOut={() => void exitTranscriptEdit()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      void exitTranscriptEdit()
                    }
                  }}
                  class="max-h-[80px] min-h-[28px] min-w-0 flex-1 resize-none rounded-lg px-2.5 py-1 font-[inherit] text-sm outline-none"
                  style={{
                    background: 'var(--c-bg)',
                    border: '1px solid var(--c-accent)',
                    color: 'var(--c-text)'
                  }}
                />
              }
            >
              <span
                class="min-w-0 flex-1 cursor-pointer truncate text-sm"
                style={{
                  color: inputValue().trim() ? 'var(--c-text)' : 'var(--c-text-muted)',
                  'font-style': inputValue().trim() ? 'normal' : 'italic'
                }}
                onClick={enterTranscriptEdit}
              >
                {inputValue().trim() || (streamingState() === 'streaming' ? 'Listening…' : 'Tap to edit')}
              </span>
            </Show>

            {/* Cancel */}
            <span
              class="shrink-0 cursor-pointer px-2 py-1 text-xs"
              style={{ color: 'var(--c-text-muted)' }}
              onClick={cancelRecording}
            >
              cancel
            </span>
          </div>
        </Show>

        {/* Action buttons */}
        <div
          class="flex shrink-0 flex-row items-center gap-2.5 transition-all"
          classList={{
            'max-sm:flex-col max-sm:gap-1.5': textFocused()
          }}
        >
          {/* Scratchpad button */}
          <button
            class="relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all"
            style={{
              background: 'var(--c-bg)',
              'border-color': inputValue().trim() ? 'var(--c-accent)' : 'var(--c-border)',
              color: inputValue().trim() ? 'var(--c-accent)' : 'var(--c-text-muted)'
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleScratchpadButton}
            title={inputValue().trim() ? 'Save to scratchpad' : 'Open scratchpad'}
          >
            <Show
              when={inputValue().trim()}
              fallback={
                <>
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                    <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                  </svg>
                  <Show when={scratchpad().length > 0}>
                    <span
                      class="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
                      style={{ background: 'var(--c-badge-count, var(--c-accent))' }}
                    >
                      {scratchpad().length}
                    </span>
                  </Show>
                </>
              }
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
            </Show>
          </button>

          {/* Mic button */}
          <button
            class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-all"
            classList={{
              'animate-mic-pulse': isRecording()
            }}
            style={{
              background: isRecording() ? 'var(--c-rec-bg, rgba(239,68,68,0.1))' : 'var(--c-bg)',
              'border-color': isRecording() ? 'var(--c-danger, #ef4444)' : 'var(--c-border)',
              color: isRecording() ? 'var(--c-danger, #ef4444)' : 'var(--c-text-muted)'
            }}
            onClick={toggleStreaming}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>

          {/* Send / Stop button */}
          <Show
            when={isBusyOrStreaming()}
            fallback={
              <div class="relative" data-send-menu>
                <button
                  class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-none text-white transition-all disabled:cursor-default disabled:opacity-30"
                  style={{ background: 'var(--c-accent)' }}
                  disabled={retryCountdownSeconds() > 0 || (!inputValue().trim() && !attachedFiles().length)}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.preventDefault()
                    startLongPress()
                  }}
                  onPointerUp={handleSendPointerUp}
                  onPointerLeave={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>

                {/* Long-press send options menu */}
                <Show when={sendMenuOpen()}>
                  <div
                    class="absolute right-0 bottom-full z-50 mb-2 min-w-[200px] overflow-hidden rounded-xl shadow-lg"
                    style={{ background: 'var(--c-bg)', border: '1px solid var(--c-border)' }}
                  >
                    <button
                      class="flex w-full cursor-pointer items-center gap-2.5 border-none px-4 py-3 text-left text-sm transition-colors"
                      style={{ background: 'transparent', color: 'var(--c-text)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--c-bg-raised)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      onClick={handleSendImmediate}
                    >
                      <span style={{ 'flex-shrink': '0', 'font-size': '16px' }}>⚡</span>
                      <span>Send immediately</span>
                    </button>
                  </div>
                </Show>
              </div>
            }
          >
            <button
              class="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-none text-white transition-all"
              style={{ background: 'var(--c-danger, #ef4444)' }}
              onClick={() => {
                if (props.onAbort) props.onAbort()
                else abortChat()
              }}
              title="Stop"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}
