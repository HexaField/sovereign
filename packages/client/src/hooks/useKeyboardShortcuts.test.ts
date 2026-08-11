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

import { handleShortcut, VIEW_SHORTCUTS } from './useKeyboardShortcuts.js'
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

  it('ignores events without metaKey', () => {
    const e = makeKeyEvent('1', false)
    expect(handleShortcut(e)).toBe(false)
  })

  it('VIEW_SHORTCUTS map has no entries (mode toggle replaces numbered shortcuts)', () => {
    expect(Object.keys(VIEW_SHORTCUTS)).toEqual([])
  })
})
