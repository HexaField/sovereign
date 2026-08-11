import { createEffect, onCleanup } from 'solid-js'
import { toggleMode } from '../features/nav/store.js'
import { toggleChatExpanded, toggleSidebar } from '../features/workspace/store.js'
import { setQuickSwitchOpen, quickSwitchOpen } from '../features/threads/QuickSwitchModal.js'

/**
 * Cmd+1 toggles between workspace and agent modes.
 * No additional view shortcuts needed — agent tabs have their own
 * tab bar and don't require numbered shortcuts.
 */
export const VIEW_SHORTCUTS: Record<string, string> = {}

/** Handle a keyboard event, returning true if it was consumed */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey) return false

  // Cmd+1 — toggle between workspace and agent modes
  if (!e.shiftKey && e.key === '1') {
    e.preventDefault()
    toggleMode()
    return true
  }

  // Cmd+Shift+E — toggle expand chat
  if (e.shiftKey && (e.key === 'E' || e.key === 'e')) {
    e.preventDefault()
    toggleChatExpanded()
    return true
  }

  // Cmd+B — toggle sidebar
  if (!e.shiftKey && (e.key === 'b' || e.key === 'B')) {
    e.preventDefault()
    toggleSidebar()
    return true
  }

  // Cmd+K — thread quick-switch
  if (!e.shiftKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    setQuickSwitchOpen(!quickSwitchOpen())
    return true
  }

  // Cmd+Shift+W — workspace picker (placeholder)
  if (e.shiftKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault()
    return true
  }

  return false
}

/** SolidJS hook to register global keyboard shortcuts */
export function useKeyboardShortcuts(): void {
  createEffect(() => {
    if (typeof document === 'undefined') return
    const listener = (e: KeyboardEvent) => handleShortcut(e)
    document.addEventListener('keydown', listener)
    onCleanup(() => document.removeEventListener('keydown', listener))
  })
}
