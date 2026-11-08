import { createEffect, onCleanup } from 'solid-js'
import { toggleMode } from '../features/nav/store.js'
import { toggleChatExpanded, toggleSidebar } from '../features/workspace/store.js'
import { setQuickSwitchOpen, quickSwitchOpen } from '../features/threads/QuickSwitchModal.js'
import { setQuickOpenOpen, quickOpenOpen } from '../features/workspace/FileQuickOpen.js'

/**
 * Cmd+1 toggles between workspace and agent modes.
 * No additional view shortcuts needed — agent tabs have their own
 * tab bar and don't require numbered shortcuts.
 */
export const VIEW_SHORTCUTS: Record<string, string> = {}

export function isMacPlatform(
  nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator
): boolean {
  return /mac|iphone|ipad/i.test(nav?.platform || nav?.userAgent || '')
}

/**
 * Cmd+P on macOS, Ctrl+P elsewhere (Cmd+P too) — file quick-open; it also stops
 * the browser's print dialog. macOS Ctrl+P stays "previous line" in text fields,
 * and Ctrl+P inside a terminal stays the shell's previous-command key.
 */
export function isQuickOpenKey(e: KeyboardEvent, mac = isMacPlatform()): boolean {
  if (e.shiftKey || e.altKey || (e.key !== 'p' && e.key !== 'P')) return false
  if (e.metaKey) return true
  if (!e.ctrlKey || mac) return false
  const target = e.target as Element | null
  return !(typeof target?.closest === 'function' && target.closest('.xterm'))
}

/** Handle a keyboard event, returning true if it was consumed */
export function handleShortcut(e: KeyboardEvent): boolean {
  if (isQuickOpenKey(e)) {
    e.preventDefault()
    setQuickSwitchOpen(false)
    setQuickOpenOpen(!quickOpenOpen())
    return true
  }

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
    setQuickOpenOpen(false)
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
