import { createSignal } from 'solid-js'
import type { Accessor } from 'solid-js'
import type { Theme } from './themes.js'

const STORAGE_KEY = 'sovereign:theme'
const VALID_THEMES: Theme[] = ['default', 'light', 'ironman', 'jarvis']

function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && VALID_THEMES.includes(value as Theme)
}

function loadTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'default'
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && isValidTheme(stored)) return stored
  // Respect OS preference if no explicit choice stored
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light'
  }
  return 'default'
}

function applyThemeClass(theme: Theme): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.classList.remove('light', 'ironman', 'jarvis')
  if (theme !== 'default') {
    el.classList.add(theme)
  }
}

const [_currentTheme, _setTheme] = createSignal<Theme>(loadTheme())

// Apply on init
applyThemeClass(_currentTheme())

export const currentTheme: Accessor<Theme> = _currentTheme

function applyTheme(theme: Theme): void {
  _setTheme(theme)
  applyThemeClass(theme)
}

export function setTheme(theme: Theme): void {
  if (!isValidTheme(theme)) return
  applyTheme(theme)
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, theme)
  }
}

// A `storage` event fires only in the other tabs of this origin, on this device,
// so a theme chosen here reaches them and no other device. Apply without
// writing back: that write would not loop, but there is nothing to store.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && isValidTheme(e.newValue)) applyTheme(e.newValue)
  })
}
