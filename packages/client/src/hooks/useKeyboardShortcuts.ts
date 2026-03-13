import { createEffect, onCleanup } from 'solid-js'
import { setActiveView, type NavView } from '../features/nav/store.js'
import { toggleChatExpanded, toggleSidebar } from '../features/workspace/store.js'

/** Map of Cmd+N view shortcuts */
export const VIEW_SHORTCUTS: Record<string, NavView> = {
  '1': 'dashboard',
  '2': 'workspace',
  '3': 'canvas',
  '4': 'planning',
  '5': 'system'
}

/** Handle a keyboard event, returning true if it was consumed */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey) return false

  // Cmd+1..5 — switch views
  if (!e.shiftKey && VIEW_SHORTCUTS[e.key]) {
    e.preventDefault()
    setActiveView(VIEW_SHORTCUTS[e.key])
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

  // Cmd+Shift+W — workspace picker (placeholder)
  if (e.shiftKey && (e.key === 'W' || e.key === 'w')) {
    e.preventDefault()
    // No-op placeholder for workspace picker
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
