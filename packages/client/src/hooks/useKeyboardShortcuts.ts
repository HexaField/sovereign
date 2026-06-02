import { createEffect, onCleanup } from 'solid-js'
import { setActiveView, toggleDashboardModal, type NavView } from '../features/nav/store.js'
import { toggleChatExpanded, toggleSidebar } from '../features/workspace/store.js'
import { setQuickSwitchOpen, quickSwitchOpen } from '../features/threads/QuickSwitchModal.js'

/**
 * Map of Cmd+N view shortcuts. `'1'` is intentionally omitted — Cmd+1
 * toggles the dashboard modal (see `handleShortcut`), it does not
 * switch the underlying view.
 */
export const VIEW_SHORTCUTS: Record<string, NavView> = {
  '2': 'workspace',
  '3': 'canvas',
  '4': 'planning',
  '5': 'system'
}

/** Handle a keyboard event, returning true if it was consumed */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (!e.metaKey) return false

  // Cmd+1 — toggle dashboard modal (synonym for clicking the ⬡ button)
  if (!e.shiftKey && e.key === '1') {
    e.preventDefault()
    toggleDashboardModal()
    return true
  }

  // Cmd+2..5 — switch underlying views
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

  // Cmd+K — thread quick-switch
  if (!e.shiftKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault()
    setQuickSwitchOpen(!quickSwitchOpen())
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
