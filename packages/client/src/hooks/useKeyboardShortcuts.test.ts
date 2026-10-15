import { describe, it, expect, beforeEach } from 'vitest'

// Mock localStorage
const store: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    },
    removeItem: (k: string) => {
      delete store[k]
    },
    clear: () => Object.keys(store).forEach((k) => delete store[k])
  },
  writable: true
})

import { handleShortcut, isMacPlatform, isQuickOpenKey, VIEW_SHORTCUTS } from './useKeyboardShortcuts.js'
import { quickSwitchOpen, setQuickSwitchOpen } from '../features/threads/QuickSwitchModal.js'
import { quickOpenOpen, setQuickOpenOpen } from '../features/workspace/FileQuickOpen.js'
import { activeView, _setActiveView } from '../features/nav/store.js'
import { chatExpanded, setChatExpanded, sidebarCollapsed, setSidebarCollapsed } from '../features/workspace/store.js'

function makeKeyEvent(key: string, metaKey = true, shiftKey = false): KeyboardEvent {
  let prevented = false
  return {
    key,
    metaKey,
    shiftKey,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => {
      prevented = true
    },
    get defaultPrevented() {
      return prevented
    }
  } as unknown as KeyboardEvent
}

beforeEach(() => {
  _setActiveView('workspace')
  setChatExpanded(false)
  setSidebarCollapsed(false)
})

describe('§8 Keyboard Shortcuts', () => {
  it('Cmd+1 toggles between workspace and agent modes', () => {
    expect(activeView()).toBe('workspace')
    const e1 = makeKeyEvent('1')
    expect(handleShortcut(e1)).toBe(true)
    expect(e1.defaultPrevented).toBe(true)
    expect(activeView()).toBe('agent')
    const e2 = makeKeyEvent('1')
    expect(handleShortcut(e2)).toBe(true)
    expect(activeView()).toBe('workspace')
  })

  it('Cmd+Shift+E toggles chat expanded', () => {
    expect(chatExpanded()).toBe(false)
    handleShortcut(makeKeyEvent('E', true, true))
    expect(chatExpanded()).toBe(true)
    handleShortcut(makeKeyEvent('E', true, true))
    expect(chatExpanded()).toBe(false)
  })

  it('Cmd+B toggles sidebar', () => {
    expect(sidebarCollapsed()).toBe(false)
    handleShortcut(makeKeyEvent('b', true, false))
    expect(sidebarCollapsed()).toBe(true)
    handleShortcut(makeKeyEvent('b', true, false))
    expect(sidebarCollapsed()).toBe(false)
  })

  it('Cmd+Shift+W handles workspace picker placeholder', () => {
    const e = makeKeyEvent('W', true, true)
    expect(handleShortcut(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
  })

  it('Cmd+P toggles file quick-open and stops the print dialog', () => {
    setQuickOpenOpen(false)
    const cmd = makeKeyEvent('p')
    expect(handleShortcut(cmd)).toBe(true)
    expect(cmd.defaultPrevented).toBe(true)
    expect(quickOpenOpen()).toBe(true)
    expect(handleShortcut(makeKeyEvent('P'))).toBe(true)
    expect(quickOpenOpen()).toBe(false)
    // Cmd+Shift+P stays free for the browser / other bindings.
    expect(handleShortcut(makeKeyEvent('P', true, true))).toBe(false)
  })

  it('leaves Ctrl+P alone on macOS and inside a terminal', () => {
    const ctrlP = (target?: unknown) =>
      ({ ...makeKeyEvent('p', false), ctrlKey: true, target }) as unknown as KeyboardEvent
    expect(isQuickOpenKey(makeKeyEvent('p'), true)).toBe(true)
    expect(isQuickOpenKey(ctrlP(), true)).toBe(false)
    expect(isQuickOpenKey(ctrlP(), false)).toBe(true)
    const inTerminal = { closest: (sel: string) => (sel === '.xterm' ? {} : null) }
    expect(isQuickOpenKey(ctrlP(inTerminal), false)).toBe(false)
    expect(isQuickOpenKey(makeKeyEvent('p', true), false)).toBe(true)
    expect(isMacPlatform({ platform: 'MacIntel' })).toBe(true)
    expect(isMacPlatform({ platform: 'Linux x86_64' })).toBe(false)
  })

  it('opening one palette closes the other', () => {
    setQuickOpenOpen(false)
    setQuickSwitchOpen(false)
    handleShortcut(makeKeyEvent('k'))
    expect(quickSwitchOpen()).toBe(true)
    handleShortcut(makeKeyEvent('p'))
    expect(quickOpenOpen()).toBe(true)
    expect(quickSwitchOpen()).toBe(false)
    handleShortcut(makeKeyEvent('k'))
    expect(quickOpenOpen()).toBe(false)
    setQuickSwitchOpen(false)
  })

  it('ignores events without metaKey', () => {
    const e = makeKeyEvent('1', false)
    expect(handleShortcut(e)).toBe(false)
  })

  it('VIEW_SHORTCUTS map has no entries (mode toggle replaces numbered shortcuts)', () => {
    expect(Object.keys(VIEW_SHORTCUTS)).toEqual([])
  })
})
