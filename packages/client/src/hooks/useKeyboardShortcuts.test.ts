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
  _setActiveView('dashboard')
  setChatExpanded(false)
  setSidebarCollapsed(false)
})

describe('§8 Keyboard Shortcuts', () => {
  it('Cmd+1..5 switches views', () => {
    const views = ['dashboard', 'workspace', 'canvas', 'planning', 'system'] as const
    for (let i = 0; i < views.length; i++) {
      const e = makeKeyEvent(String(i + 1))
      const consumed = handleShortcut(e)
      expect(consumed).toBe(true)
      expect(activeView()).toBe(views[i])
      expect(e.defaultPrevented).toBe(true)
    }
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

  it('Cmd+Shift+W is handled (workspace picker placeholder)', () => {
    const e = makeKeyEvent('W', true, true)
    expect(handleShortcut(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
  })

  it('ignores events without metaKey', () => {
    const e = makeKeyEvent('1', false)
    expect(handleShortcut(e)).toBe(false)
  })

  it('VIEW_SHORTCUTS maps 1-5 to views', () => {
    expect(Object.keys(VIEW_SHORTCUTS)).toEqual(['1', '2', '3', '4', '5'])
  })
})
