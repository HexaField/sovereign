// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Theme } from './themes.js'

let currentTheme: () => Theme
let setTheme: (t: Theme) => void

beforeEach(async () => {
  localStorage.clear()
  document.documentElement.classList.remove('light', 'ironman', 'jarvis')
  vi.resetModules()
  const mod = await import('./store.js')
  currentTheme = mod.currentTheme
  setTheme = mod.setTheme
})

describe('§1.4 Theme Store', () => {
  it('MUST expose currentTheme: Accessor<Theme> and setTheme(theme): void', () => {
    expect(typeof currentTheme).toBe('function')
    expect(typeof setTheme).toBe('function')
    const val = currentTheme()
    expect(['default', 'light', 'ironman', 'jarvis']).toContain(val)
  })

  it('MUST persist selected theme to localStorage key sovereign:theme', () => {
    setTheme('ironman')
    expect(localStorage.getItem('sovereign:theme')).toBe('ironman')
  })

  it('MUST restore theme from localStorage on load', async () => {
    localStorage.setItem('sovereign:theme', 'jarvis')
    vi.resetModules()
    const mod = await import('./store.js')
    expect(mod.currentTheme()).toBe('jarvis')
  })

  it('MUST apply selected theme by setting CSS class on document.documentElement', () => {
    setTheme('light')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    setTheme('ironman')
    expect(document.documentElement.classList.contains('ironman')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)

    setTheme('default')
    expect(document.documentElement.classList.contains('ironman')).toBe(false)
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(document.documentElement.classList.contains('jarvis')).toBe(false)
  })

  it('SHOULD support prefers-color-scheme media query for automatic dark/light selection', async () => {
    localStorage.clear()
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: light)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn()
    }))
    vi.resetModules()
    const mod = await import('./store.js')
    expect(mod.currentTheme()).toBe('light')
    window.matchMedia = originalMatchMedia
  })

  it('Theme type MUST be: default | light | ironman | jarvis', () => {
    const validThemes: Theme[] = ['default', 'light', 'ironman', 'jarvis']
    for (const t of validThemes) {
      setTheme(t)
      expect(currentTheme()).toBe(t)
    }
  })
})
