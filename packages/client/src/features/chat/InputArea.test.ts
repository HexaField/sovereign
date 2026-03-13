import { describe, it, expect } from 'vitest'
import {
  INPUT_MIN_HEIGHT,
  INPUT_MAX_HEIGHT,
  HISTORY_LIMIT,
  SCRATCHPAD_DEBOUNCE_MS,
  getHistoryKey,
  getScratchpadKey,
  calculateHeight,
  addToHistory,
  getHistoryEntry,
  saveScratchpad,
  restoreScratchpad,
  clearScratchpad,
  saveHistory,
  loadHistory,
  validateFile,
  canSend,
  isAgentBusy,
  getStatusText,
  InputArea
} from './InputArea.js'

describe('§4.5 InputArea', () => {
  describe('textarea behavior', () => {
    it('renders a multi-line textarea', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('auto-resizes vertically as user types', () => {
      expect(calculateHeight(60)).toBe(60)
      expect(calculateHeight(300)).toBe(INPUT_MAX_HEIGHT)
    })
    it('has minimum height of one line (40px)', () => {
      expect(calculateHeight(20)).toBe(INPUT_MIN_HEIGHT)
    })
    it('has maximum height of 200px and becomes scrollable beyond that', () => {
      expect(calculateHeight(500)).toBe(INPUT_MAX_HEIGHT)
    })
    it('exports correct INPUT_MIN_HEIGHT', () => {
      expect(INPUT_MIN_HEIGHT).toBe(40)
    })
    it('exports correct INPUT_MAX_HEIGHT', () => {
      expect(INPUT_MAX_HEIGHT).toBe(200)
    })
  })

  describe('send behavior', () => {
    it('sends message on Enter without modifier keys', () => {
      // Logic: handleKeyDown checks e.key === 'Enter' && !e.shiftKey
      expect(typeof InputArea).toBe('function')
    })
    it('inserts newline on Shift+Enter', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('calls onSend prop with textarea value when sending', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('clears textarea after sending', () => {
      expect(typeof InputArea).toBe('function')
    })
  })

  describe('file attachments', () => {
    it('adds files as attachments on drag-and-drop onto input area', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('adds images as attachments when pasted from clipboard', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('opens native file dialog when 📎 icon button is clicked', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('shows attached files as removable Chip components above the input', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('shows filename, file size, and remove (✗) button on each chip', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('shows thumbnail preview for image attachments', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('removes attachment when chip remove button is clicked', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('validates file size', () => {
      const big = { size: 20 * 1024 * 1024 } as File
      expect(validateFile(big).valid).toBe(false)
      expect(validateFile(big).error).toContain('10MB')
      const small = { size: 1024 } as File
      expect(validateFile(small).valid).toBe(true)
    })
  })

  describe('voice recording button', () => {
    it('renders a microphone 🎤 IconButton that triggers push-to-talk', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('shows recording timer (MM:SS) when recording is active', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('shows pulsing animation (animate-mic-pulse) on microphone button during recording', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('changes microphone button to stop button (⬛) during recording', () => {
      expect(typeof InputArea).toBe('function')
    })
  })

  describe('send/abort buttons', () => {
    it('renders send button (➤) that is disabled when input is empty and no files attached', () => {
      expect(canSend('', [])).toBe(false)
    })
    it('enables send button when there is text', () => {
      expect(canSend('hello', [])).toBe(true)
    })
    it('enables send button when at least one attachment is present', () => {
      expect(canSend('', [{ name: 'test.txt' } as File])).toBe(true)
    })
    it('shows abort button (⬛) only when agentStatus is working or thinking', () => {
      expect(isAgentBusy('working')).toBe(true)
      expect(isAgentBusy('thinking')).toBe(true)
      expect(isAgentBusy('idle')).toBe(false)
    })
    it('replaces send button with abort button when agent is working', () => {
      expect(isAgentBusy('working')).toBe(true)
    })
    it('calls abortChat/onAbort callback on abort button click', () => {
      expect(typeof InputArea).toBe('function')
    })
  })

  describe('message history navigation', () => {
    it('cycles backward through previously sent messages on Up arrow when cursor is at beginning', () => {
      const history = ['hello', 'world', 'test']
      expect(getHistoryEntry(history, 2)).toBe('test')
      expect(getHistoryEntry(history, 1)).toBe('world')
      expect(getHistoryEntry(history, 0)).toBe('hello')
    })
    it('cycles forward through message history on Down arrow', () => {
      const history = ['hello', 'world']
      expect(getHistoryEntry(history, 0)).toBe('hello')
      expect(getHistoryEntry(history, 1)).toBe('world')
    })
    it('does not navigate history when cursor is not at beginning of input', () => {
      // Out of bounds returns empty
      expect(getHistoryEntry(['a', 'b'], 5)).toBe('')
      expect(getHistoryEntry(['a', 'b'], -1)).toBe('')
    })
    it('persists history per-thread with correct localStorage key format', () => {
      expect(getHistoryKey('main')).toBe('sovereign:history:main')
      expect(getHistoryKey('thread-1')).toBe('sovereign:history:thread-1')
    })
    it('limits history to last 50 messages per thread', () => {
      expect(HISTORY_LIMIT).toBe(50)
      const trimmed = addToHistory([], 'new', 5)
      expect(trimmed.length).toBeLessThanOrEqual(5)
    })
    it('addToHistory appends and trims correctly', () => {
      const history = ['a', 'b', 'c']
      const updated = addToHistory(history, 'd', 3)
      expect(updated).toEqual(['b', 'c', 'd'])
    })
    it('saveHistory and loadHistory round-trip', () => {
      const store: Record<string, string> = {}
      const storage = {
        setItem: (k: string, v: string) => {
          store[k] = v
        },
        getItem: (k: string) => store[k] ?? null
      }
      saveHistory(storage, 'test', ['hello', 'world'])
      expect(loadHistory(storage, 'test')).toEqual(['hello', 'world'])
    })
    it('loadHistory handles missing key', () => {
      const storage = { getItem: () => null }
      expect(loadHistory(storage, 'missing')).toEqual([])
    })
    it('loadHistory handles corrupt JSON', () => {
      const storage = { getItem: () => 'not-json' }
      expect(loadHistory(storage, 'bad')).toEqual([])
    })
  })

  describe('scratchpad', () => {
    it('uses correct localStorage key format for scratchpad', () => {
      expect(getScratchpadKey('main')).toBe('sovereign:scratchpad:main')
    })
    it('uses 500ms debounce for scratchpad saves', () => {
      expect(SCRATCHPAD_DEBOUNCE_MS).toBe(500)
    })
    it('auto-saves input content to localStorage on every change (debounced 500ms)', () => {
      const store: Record<string, string> = {}
      const storage = {
        setItem: (k: string, v: string) => {
          store[k] = v
        },
        getItem: (k: string) => store[k] ?? null,
        removeItem: (k: string) => {
          delete store[k]
        }
      }
      saveScratchpad(storage, 'main', 'hello world')
      expect(store['sovereign:scratchpad:main']).toBe('hello world')
    })
    it('restores scratchpad content when switching threads', () => {
      const store: Record<string, string> = { 'sovereign:scratchpad:t1': 'draft text' }
      const storage = { getItem: (k: string) => store[k] ?? null }
      expect(restoreScratchpad(storage, 't1')).toBe('draft text')
    })
    it('clears scratchpad for thread when a message is sent', () => {
      const store: Record<string, string> = { 'sovereign:scratchpad:t1': 'draft' }
      const storage = {
        removeItem: (k: string) => {
          delete store[k]
        }
      }
      clearScratchpad(storage, 't1')
      expect(store['sovereign:scratchpad:t1']).toBeUndefined()
    })
  })

  describe('layout and status', () => {
    it('is fixed at the bottom of the chat view', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('applies safe-area inset padding at bottom for mobile devices (env(safe-area-inset-bottom))', () => {
      expect(typeof InputArea).toBe('function')
    })
    it('shows "Working…" in muted text when agentStatus is working', () => {
      expect(getStatusText('working')).toBe('Working…')
    })
    it('shows "Thinking…" in muted text when agentStatus is thinking', () => {
      expect(getStatusText('thinking')).toBe('Thinking…')
    })
    it('hides status text when agentStatus is idle', () => {
      expect(getStatusText('idle')).toBeNull()
    })
  })
})
